import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

interface LineEvent {
  type: string;
  message?: { type: string; text: string };
  source: { userId: string; type: string };
  replyToken: string;
}

serve(async (req) => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  const body = await req.text();
  const webhook = JSON.parse(body);
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  );
  await Promise.all(
    webhook.events
      .filter((e: LineEvent) => e.type === "message" && e.message?.type === "text")
      .map((event: LineEvent) => handleMessage(event, supabase))
  );
  return new Response("OK", { status: 200 });
});

async function handleMessage(event: LineEvent, supabase: any) {
  const lineUserId = event.source.userId;
  const userMessage = event.message!.text;
  const replyToken = event.replyToken;

  try {
    const lineChannelId = Deno.env.get("LINE_CHANNEL_ID") ?? "";
    const { data: salon } = await supabase
      .from("salons").select("*").eq("line_channel_id", lineChannelId).single();
    if (!salon) { console.error("Salon not found:", lineChannelId); return; }

    let { data: customer } = await supabase
      .from("customers").select("*")
      .eq("salon_id", salon.id).eq("line_user_id", lineUserId).single();
    if (!customer) {
      const displayName = await getLineDisplayName(lineUserId, salon.line_access_token);
      const { data: newCustomer } = await supabase
        .from("customers")
        .insert({ salon_id: salon.id, line_user_id: lineUserId, name: displayName ?? "お客様" })
        .select().single();
      customer = newCustomer;
    }

    const { data: history } = await supabase
      .from("conversations").select("role, content")
      .eq("customer_id", customer.id)
      .order("created_at", { ascending: false }).limit(20);
    const conversationHistory = (history ?? []).reverse();

    await supabase.from("conversations").insert({
      salon_id: salon.id, customer_id: customer.id, role: "user", content: userMessage,
    });

    const { data: upcomingAppointments } = await supabase
      .from("appointments").select("*")
      .eq("customer_id", customer.id).in("status", ["pending", "confirmed"])
      .gte("scheduled_at", new Date().toISOString())
      .order("scheduled_at", { ascending: true }).limit(3);

    const reply = await callClaude({
      salon, customer, userMessage,
      conversationHistory,
      upcomingAppointments: upcomingAppointments ?? [],
    });

    if (reply.includes("承りました")) {
      await saveAppointment(reply, conversationHistory, userMessage, customer, salon, supabase);
    }

    await supabase.from("conversations").insert({
      salon_id: salon.id, customer_id: customer.id, role: "assistant", content: reply,
    });

    await replyToLine(replyToken, reply, salon.line_access_token);
  } catch (err) {
    console.error("handleMessage error:", err);
    await replyToLine(replyToken, "申し訳ございません、少し時間をおいて再度お試しください",
      Deno.env.get("LINE_ACCESS_TOKEN") ?? "");
  }
}

async function saveAppointment(
  reply: string,
  history: { role: string; content: string }[],
  lastMessage: string,
  customer: any,
  salon: any,
  supabase: any
) {
  try {
    const conversationText = [
      ...history.map(h => `${h.role === "user" ? "お客様" : "MIRRA"}: ${h.content}`),
      `お客様: ${lastMessage}`,
      `MIRRA: ${reply}`,
    ].join("\n");

    const extractRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": Deno.env.get("ANTHROPIC_API_KEY") ?? "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 200,
        system: `以下の会話から予約情報を抽出し、JSONのみ返してください。余分なテキスト不要。
{"scheduled_at":"ISO8601日時（例：2026-06-07T14:00:00+09:00）","menu":"メニュー名","staff_name":"担当名またはnull"}
今日: ${new Date().toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" })}`,
        messages: [{ role: "user", content: conversationText }],
      }),
    });

    if (!extractRes.ok) return;
    const extractData = await extractRes.json();
    const appointmentInfo = JSON.parse(extractData.content[0].text.trim());
    if (!appointmentInfo.scheduled_at) return;

    const { error } = await supabase.from("appointments").insert({
      salon_id: salon.id,
      customer_id: customer.id,
      scheduled_at: appointmentInfo.scheduled_at,
      menu: appointmentInfo.menu ?? null,
      staff_name: appointmentInfo.staff_name ?? null,
      status: "confirmed",
    });

    if (error) {
      console.error("appointment insert error:", error);
    } else {
      console.log("Appointment saved:", appointmentInfo);
      await supabase.from("customers")
        .update({ last_visit_at: new Date().toISOString() })
        .eq("id", customer.id);
    }
  } catch (err) {
    console.error("saveAppointment error:", err);
  }
}

async function callClaude({ salon, customer, userMessage, conversationHistory, upcomingAppointments }: any) {
  const today = new Date().toLocaleDateString("ja-JP", {
    year: "numeric", month: "long", day: "numeric", weekday: "long", timeZone: "Asia/Tokyo",
  });
  const appointmentInfo = upcomingAppointments.length > 0
    ? upcomingAppointments.map((a: any) => {
        const date = new Date(a.scheduled_at).toLocaleString("ja-JP", {
          timeZone: "Asia/Tokyo", month: "long", day: "numeric", weekday: "short",
          hour: "2-digit", minute: "2-digit",
        });
        return `${date} ${a.menu ?? ""}`;
      }).join("\n")
    : "なし";

  const systemPrompt = `${salon.claude_system_prompt ?? "あなたはMIRRA（ミラ）という美容室の予約AIアシスタントです。"}

【サロン名】${salon.name}
【今日】${today}
【お客様】${customer.name ?? "未登録"}（来店${customer.visit_count}回）
【直近の予約】${appointmentInfo}

【ルール】
- 予約受付時は「日付」「時間帯」「メニュー」を必ず確認する
- 曖昧な日付は具体的な日付を添えて確認する
- 予約確定時は必ず「✅ ご予約を承りました」と返答に含める
- 返答は短くLINEらしい文体で。絵文字は1〜2個まで`;

  const messages = [
    ...conversationHistory.map((h: any) => ({ role: h.role, content: h.content })),
    { role: "user", content: userMessage },
  ];

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": Deno.env.get("ANTHROPIC_API_KEY") ?? "",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      system: systemPrompt,
      messages,
    }),
  });

  if (!res.ok) throw new Error(`Claude API error: ${await res.text()}`);
  const data = await res.json();
  return data.content[0].text as string;
}

async function getLineDisplayName(userId: string, accessToken: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.line.me/v2/bot/profile/${userId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.displayName ?? null;
  } catch { return null; }
}

async function replyToLine(replyToken: string, text: string, accessToken: string) {
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ replyToken, messages: [{ type: "text", text }] }),
  });
}
