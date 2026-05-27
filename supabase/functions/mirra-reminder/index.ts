import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve(async (req) => {
  // cronからのPOSTまたはGETを許可
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  );

  try {
    // 日本時間で「明日」の範囲を計算
    const now = new Date();
    const jstOffset = 9 * 60 * 60 * 1000;
    const todayJST = new Date(now.getTime() + jstOffset);
    todayJST.setUTCHours(0, 0, 0, 0);

    const tomorrowStart = new Date(todayJST.getTime() + 24 * 60 * 60 * 1000);
    const tomorrowEnd = new Date(todayJST.getTime() + 48 * 60 * 60 * 1000 - 1);

    // 明日の予約でリマインド未送信のものを取得
    const { data: appointments, error } = await supabase
      .from("appointments")
      .select(`
        *,
        customers (name, line_user_id),
        salons (name, line_access_token)
      `)
      .in("status", ["confirmed", "pending"])
      .eq("reminder_sent", false)
      .gte("scheduled_at", tomorrowStart.toISOString())
      .lte("scheduled_at", tomorrowEnd.toISOString());

    if (error) throw error;
    if (!appointments || appointments.length === 0) {
      return new Response(JSON.stringify({ sent: 0 }), { status: 200 });
    }

    let sentCount = 0;
    for (const apt of appointments) {
      const customer = apt.customers;
      const salon = apt.salons;
      if (!customer?.line_user_id || !salon?.line_access_token) continue;

      const aptTime = new Date(apt.scheduled_at).toLocaleString("ja-JP", {
        timeZone: "Asia/Tokyo",
        month: "long", day: "numeric", weekday: "short",
        hour: "2-digit", minute: "2-digit",
      });

      const message = `${customer.name ?? "お客様"}、明日のご予約のリマインドです😊\n\n` +
        `📅 ${aptTime}\n` +
        `✂️ ${apt.menu ?? "施術"}\n\n` +
        `ご来店をお待ちしております✨\n` +
        `変更・キャンセルはこちらでお気軽にご連絡ください。`;

      // LINE Push通知送信
      const res = await fetch("https://api.line.me/v2/bot/message/push", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${salon.line_access_token}`,
        },
        body: JSON.stringify({
          to: customer.line_user_id,
          messages: [{ type: "text", text: message }],
        }),
      });

      if (res.ok) {
        // reminder_sent を true に更新
        await supabase
          .from("appointments")
          .update({ reminder_sent: true })
          .eq("id", apt.id);
        sentCount++;
        console.log(`Reminder sent to ${customer.name}`);
      } else {
        console.error(`Failed to send reminder to ${customer.name}:`, await res.text());
      }
    }

    return new Response(JSON.stringify({ sent: sentCount }), { status: 200 });
  } catch (err) {
    console.error("reminder error:", err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});
