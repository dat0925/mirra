// supabase/functions/mirra-webhook/index.ts
// MIRRA - LINE Webhook受信 + Claude API予約会話 Edge Function

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createHmac } from "https://deno.land/std@0.168.0/node/crypto.ts";

// ============================================
// 型定義
// ============================================
interface LineEvent {
  type: string;
  message?: { type: string; text: string };
  source: { userId: string; type: string };
  replyToken: string;
}

interface LineWebhookBody {
  destination: string;
  events: LineEvent[];
}

// ============================================
// メインハンドラ
// ============================================
serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const body = await req.text();

  // LINE署名検証
  const channelSecret = Deno.env.get("LINE_CHANNEL_SECRET") ?? "";
  const signature = req.headers.get("x-line-signature") ?? "";
  if (!verifySignature(body, channelSecret, signature)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const webhook: LineWebhookBody = JSON.parse(body);

  // Supabaseクライアント初期化
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  );

  // イベントを並列処理（LINEの仕様上複数来ることがある）
  await Promise.all(
    webhook.events
      .filter((e) => e.type === "message" && e.message?.type === "text")
      .map((event) => handleMessage(event, supabase))
  );

  return new Response("OK", { status: 200 });
});

// ============================================
// メッセージ処理
// ============================================
async function handleMessage(event: LineEvent, supabase: any) {
  const lineUserId = event.source.userId;
  const userMessage = event.message!.text;
  const replyToken = event.replyToken;

  try {
    // 1. サロン情報を取得（LINE Channel IDで特定）
    const lineChannelId = Deno.env.get("LINE_CHANNEL_ID") ?? "";
    const { data: salon } = await supabase
      .from("salons")
      .select("*")
      .eq("line_channel_id", lineChannelId)
      .single();

    if (!salon) {
      console.error("Salon not found for channel:", lineChannelId);
      return;
    }

    // 2. 顧客を取得 or 新規作成
    let { data: customer } = await supabase
      .from("customers")
      .select("*")
      .eq("salon_id", salon.id)
      .eq("line_user_id", lineUserId)
      .single();

    if (!customer) {
      // LINE表示名を取得
      const displayName = await getLineDisplayName(lineUserId, salon.line_access_token);
      const { data: newCustomer } = await supabase
        .from("customers")
        .insert({
          salon_id: salon.id,
          line_user_id: lineUserId,
          name: displayName ?? "お客様",
        })
        .select()
        .single();
      customer = newCustomer;
    }

    // 3. 会話履歴を取得（直近20件）
    const { data: history } = await supabase
      .from("conversations")
      .select("role, content")
      .eq("customer_id", customer.id)
      .order("created_at", { ascending: false })
      .limit(20);

    const conversationHistory = (history ?? []).reverse();

    // 4. ユーザーメッセージを保存
    await supabase.from("conversations").insert({
      salon_id: salon.id,
      customer_id: customer.id,
      role: "user",
      content: userMessage,
    });

    // 5. 直近の予約情報を取得
    const { data: upcomingAppointments } = await supabase
      .from("appointments")
      .select("*")
      .eq("customer_id", customer.id)
      .in("status", ["pending", "confirmed"])
      .gte("scheduled_at", new Date().toISOString())
      .order("scheduled_at", { ascending: true })
      .limit(3);

    // 6. Claude APIで返答生成
    const reply = await callClaude({
      salon,
      customer,
      userMessage,
      conversationHistory,
      upcomingAppointments: upcomingAppointments ?? [],
    });

    // 7. 予約意図を検出してDBに保存（簡易パース）
    await detectAndSaveAppointment(reply, customer, salon, supabase);

    // 8. アシスタントの返答を会話履歴に保存
    await supabase.from("conversations").insert({
      salon_id: salon.id,
      customer_id: customer.id,
      role: "assistant",
      content: reply,
    });

    // 9. LINEに返信
    await replyToLine(replyToken, reply, salon.line_access_token);
  } catch (err) {
    console.error("handleMessage error:", err);
    // エラー時もLINEにフォールバックメッセージを返す
    await replyToLine(
      replyToken,
      "申し訳ございません、少し時間をおいて再度お試しください🙏",
      Deno.env.get("LINE_ACCESS_TOKEN") ?? ""
    );
  }
}

// ============================================
// Claude API呼び出し
// ============================================
async function callClaude({
  salon,
  customer,
  userMessage,
  conversationHistory,
  upcomingAppointments,
}: {
  salon: any;
  customer: any;
  userMessage: string;
  conversationHistory: { role: string; content: string }[];
  upcomingAppointments: any[];
}) {
  const systemPrompt = buildSystemPrompt(salon, customer, upcomingAppointments);

  // 会話履歴をClaude形式に変換
  const messages = [
    ...conversationHistory.map((h) => ({
      role: h.role as "user" | "assistant",
      content: h.content,
    })),
    { role: "user" as const, content: userMessage },
  ];

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": Deno.env.get("ANTHROPIC_API_KEY") ?? "",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 400,
      system: systemPrompt,
      messages,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API error: ${err}`);
  }

  const data = await res.json();
  return data.content[0].text as string;
}

// ============================================
// システムプロンプト生成
// ============================================
function buildSystemPrompt(
  salon: any,
  customer: any,
  upcomingAppointments: any[]
) {
  const today = new Date().toLocaleDateString("ja-JP", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
    timeZone: "Asia/Tokyo",
  });

  const appointmentInfo =
    upcomingAppointments.length > 0
      ? upcomingAppointments
          .map((a) => {
            const date = new Date(a.scheduled_at).toLocaleString("ja-JP", {
              timeZone: "Asia/Tokyo",
              month: "long",
              day: "numeric",
              weekday: "short",
              hour: "2-digit",
              minute: "2-digit",
            });
            return `・${date} ${a.menu ?? ""} ${a.staff_name ? `（担当：${a.staff_name}）` : ""}（状態：${a.status}）`;
          })
          .join("\n")
      : "なし";

  return `${salon.claude_system_prompt ?? "あなたはMIRRA（ミラ）という美容室の予約AIアシスタントです。"}

【サロン情報】
サロン名：${salon.name}

【今日の日付】
${today}

【対応中のお客様】
お名前：${customer.name ?? "未登録"}
来店回数：${customer.visit_count}回

【${customer.name ?? "このお客様"}の直近の予約】
${appointmentInfo}

【対応ルール】
- 予約を受け付ける際は、必ず「日付」「時間帯」「メニュー」を確認すること
- 日付が曖昧な場合（「来週の土曜」など）は具体的な日付を添えて確認する
- 予約が確定したら「✅ ご予約を承りました」と明示する
- キャンセルや変更の場合も丁寧に確認してから処理する
- 返答は短く、LINEらしい自然な文体で
- 1メッセージに絵文字は1〜2個まで`;
}

// ============================================
// 予約確定の検出（簡易版）
// ============================================
async function detectAndSaveAppointment(
  reply: string,
  customer: any,
  salon: any,
  supabase: any
) {
  // 「ご予約を承りました」が含まれる場合、予約をDBに仮保存
  // ※本格的な日時パースはPhase2で実装
  if (reply.includes("ご予約を承りました") || reply.includes("承りました")) {
    // pending状態で予約を作成（日時は会話履歴から後で更新）
    // TODO: Phase2でClaudeのtool_useを使って構造化データ抽出
    console.log("Appointment detected in reply for customer:", customer.id);
  }
}

// ============================================
// LINE表示名取得
// ============================================
async function getLineDisplayName(
  userId: string,
  accessToken: string
): Promise<string | null> {
  try {
    const res = await fetch(`https://api.line.me/v2/bot/profile/${userId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.displayName ?? null;
  } catch {
    return null;
  }
}

// ============================================
// LINE返信送信
// ============================================
async function replyToLine(
  replyToken: string,
  text: string,
  accessToken: string
) {
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text }],
    }),
  });
}

// ============================================
// LINE署名検証
// ============================================
function verifySignature(
  body: string,
  channelSecret: string,
  signature: string
): boolean {
  const hmac = createHmac("sha256", channelSecret);
  hmac.update(body);
  const digest = hmac.digest("base64");
  return digest === signature;
}
