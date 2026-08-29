import "server-only";

import webPush from "web-push";
import type { SupabaseClient } from "@supabase/supabase-js";

type PushMessage = {
  type: string;
  title: string;
  body: string;
  url: string;
  tag?: string;
};

function configuration() {
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;
  if (!publicKey || !privateKey || !subject) return null;
  return { publicKey, privateKey, subject };
}

export async function sendPushToUser(admin: SupabaseClient, userId: string, message: PushMessage) {
  const config = configuration();
  if (!config) return { sent: 0, expired: 0, failed: 0, configured: false };
  webPush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
  const { data: subscriptions, error } = await admin.from("push_subscriptions").select("id, endpoint, p256dh, auth_secret").eq("user_id", userId).eq("enabled", true);
  if (error || !subscriptions?.length) return { sent: 0, expired: 0, failed: 0, configured: true };

  let sent = 0;
  let expired = 0;
  let failed = 0;
  await Promise.all(subscriptions.map(async (subscription) => {
    try {
      await webPush.sendNotification({ endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth_secret } }, JSON.stringify(message), { TTL: 300, urgency: "high" });
      sent += 1;
      await Promise.all([
        admin.from("push_subscriptions").update({ last_used_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", subscription.id),
        admin.from("push_delivery_events").insert({ user_id: userId, subscription_id: subscription.id, notification_type: message.type, status: "sent", provider_status: 201 })
      ]);
    } catch (cause) {
      const pushError = cause as { statusCode?: number; body?: string };
      const statusCode = pushError.statusCode ?? null;
      const isExpired = statusCode === 404 || statusCode === 410;
      if (isExpired) {
        expired += 1;
        await admin.from("push_subscriptions").update({ enabled: false, updated_at: new Date().toISOString() }).eq("id", subscription.id);
      } else failed += 1;
      await admin.from("push_delivery_events").insert({ user_id: userId, subscription_id: subscription.id, notification_type: message.type, status: isExpired ? "expired" : "failed", provider_status: statusCode, error_code: pushError.body?.slice(0, 500) ?? "web_push_failed" });
    }
  }));
  return { sent, expired, failed, configured: true };
}
