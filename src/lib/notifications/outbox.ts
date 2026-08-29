import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { sendPushToUser } from "./web-push";

type Preferences = { user_id: string; review_due: boolean; shared_goal_reminders: boolean; quiet_hours_start: string | null; quiet_hours_end: string | null; timezone: string };
type QueryResult<T> = { data: T[] | null; error: { message: string } | null };
type GoalReference = { id: string; title: string; created_by: string; partner_id: string; status: string };
type DuePathItem = { id: string; due_at: string; assignment: string; completed_by: string[]; shared_learning_goals: GoalReference | GoalReference[] };
type OutboxRow = { id: string; user_id: string; notification_type: string; title: string; body: string; destination_url: string; payload: Record<string, unknown>; attempt_count: number };

async function readAll<T>(loader: (from: number, to: number) => PromiseLike<QueryResult<T>>) {
  const rows: T[] = [];
  const pageSize = 500;
  for (let from = 0; ; from += pageSize) {
    const result = await loader(from, from + pageSize - 1);
    if (result.error) throw new Error(result.error.message);
    rows.push(...(result.data ?? []));
    if ((result.data?.length ?? 0) < pageSize) break;
  }
  return rows;
}

export async function enqueueLearningReminders(admin: SupabaseClient, now = new Date()) {
  const nowIso = now.toISOString();
  const reviewRows = await readAll<{ user_id: string }>((from, to) => admin.from("review_cards").select("user_id").is("suspended_at", null).lte("due_at", nowIso).range(from, to) as unknown as PromiseLike<QueryResult<{ user_id: string }>>);
  const dueGoalsAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  const pathRows = await readAll<DuePathItem>((from, to) => admin.from("shared_learning_path_items").select("id, due_at, assignment, completed_by, shared_learning_goals!inner(id, title, created_by, partner_id, status)").not("due_at", "is", null).lte("due_at", dueGoalsAt).eq("shared_learning_goals.status", "active").range(from, to) as unknown as PromiseLike<QueryResult<DuePathItem>>);
  const userIds = [...new Set([...reviewRows.map((row) => row.user_id), ...pathRows.flatMap((row) => { const goal = Array.isArray(row.shared_learning_goals) ? row.shared_learning_goals[0] : row.shared_learning_goals; return goal ? [goal.created_by, goal.partner_id] : []; })])];
  const { data: preferences } = userIds.length ? await admin.from("notification_preferences").select("user_id, review_due, shared_goal_reminders, quiet_hours_start, quiet_hours_end, timezone").in("user_id", userIds) : { data: [] };
  const preferenceMap = new Map((preferences ?? []).map((preference) => [preference.user_id, preference as Preferences]));
  const dayKey = nowIso.slice(0, 10);
  const reviewCounts = new Map<string, number>();
  for (const row of reviewRows) reviewCounts.set(row.user_id, (reviewCounts.get(row.user_id) ?? 0) + 1);
  const candidates: Record<string, unknown>[] = [];
  for (const [userId, count] of reviewCounts) if (preferenceMap.get(userId)?.review_due !== false) candidates.push({ user_id: userId, notification_type: "review_due", dedupe_key: `review-due:${userId}:${dayKey}`, title: "Lịch ôn đã đến hạn", body: `${count} thẻ FSRS đang chờ bạn củng cố.`, destination_url: "/review", payload: { dueCount: count }, scheduled_for: nowIso });
  for (const row of pathRows) {
    const goal = Array.isArray(row.shared_learning_goals) ? row.shared_learning_goals[0] : row.shared_learning_goals;
    if (!goal) continue;
    const required = row.assignment === "creator" ? [goal.created_by] : row.assignment === "partner" ? [goal.partner_id] : [goal.created_by, goal.partner_id];
    for (const userId of required) if (!row.completed_by.includes(userId) && preferenceMap.get(userId)?.shared_goal_reminders !== false) candidates.push({ user_id: userId, notification_type: "shared_goal_due", dedupe_key: `shared-goal-due:${row.id}:${userId}:${dayKey}`, title: "Hoạt động học chung sắp đến hạn", body: `Lộ trình “${goal.title}” có một hoạt động cần hoàn thành.`, destination_url: "/paths", payload: { goalId: goal.id, itemId: row.id }, scheduled_for: nowIso });
  }
  if (!candidates.length) return { enqueued: 0 };
  const { data, error } = await admin.from("notification_outbox").upsert(candidates, { onConflict: "dedupe_key", ignoreDuplicates: true }).select("id");
  if (error) throw new Error(error.message);
  return { enqueued: data?.length ?? 0 };
}

function localMinutes(now: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return Number(value.hour) * 60 + Number(value.minute);
}

function inQuietHours(now: Date, preference: Preferences | undefined) {
  if (!preference?.quiet_hours_start || !preference.quiet_hours_end) return false;
  try {
    const current = localMinutes(now, preference.timezone);
    const parse = (value: string) => { const [hour, minute] = value.split(":").map(Number); return hour * 60 + minute; };
    const start = parse(preference.quiet_hours_start); const end = parse(preference.quiet_hours_end);
    return start === end ? true : start < end ? current >= start && current < end : current >= start || current < end;
  } catch { return false; }
}

export async function dispatchNotificationOutbox(admin: SupabaseClient, now = new Date(), options: { userId?: string } = {}) {
  await admin.from("notification_outbox").update({ status: "pending", last_error: "stale_processing_lease_recovered", updated_at: now.toISOString() }).eq("status", "processing").lt("updated_at", new Date(now.getTime() - 10 * 60 * 1000).toISOString());
  const pending = await readAll<OutboxRow>((from, to) => {
    let query = admin.from("notification_outbox").select("id, user_id, notification_type, title, body, destination_url, payload, attempt_count").eq("status", "pending").lte("scheduled_for", now.toISOString()).order("scheduled_for").range(from, to);
    if (options.userId) query = query.eq("user_id", options.userId);
    return query as unknown as PromiseLike<QueryResult<OutboxRow>>;
  });
  const userIds = [...new Set(pending.map((row) => row.user_id))];
  const { data: preferences } = userIds.length ? await admin.from("notification_preferences").select("user_id, review_due, shared_goal_reminders, quiet_hours_start, quiet_hours_end, timezone").in("user_id", userIds) : { data: [] };
  const preferenceMap = new Map((preferences ?? []).map((preference) => [preference.user_id, preference as Preferences]));
  let sent = 0; let failed = 0; let deferred = 0; let cancelled = 0;
  for (const row of pending) {
    const preference = preferenceMap.get(row.user_id);
    const disabled = row.notification_type === "review_due" ? preference?.review_due === false : row.notification_type.startsWith("shared_goal") ? preference?.shared_goal_reminders === false : false;
    if (disabled) { await admin.from("notification_outbox").update({ status: "cancelled", updated_at: now.toISOString(), last_error: "disabled_by_user" }).eq("id", row.id).eq("status", "pending"); cancelled += 1; continue; }
    if (inQuietHours(now, preference)) { await admin.from("notification_outbox").update({ scheduled_for: new Date(now.getTime() + 30 * 60 * 1000).toISOString(), updated_at: now.toISOString() }).eq("id", row.id).eq("status", "pending"); deferred += 1; continue; }
    const { data: claimed } = await admin.from("notification_outbox").update({ status: "processing", attempt_count: row.attempt_count + 1, updated_at: now.toISOString() }).eq("id", row.id).eq("status", "pending").select("id").maybeSingle();
    if (!claimed) continue;
    try {
      const result = await sendPushToUser(admin, row.user_id, { type: row.notification_type, title: row.title, body: row.body, url: row.destination_url, tag: row.id });
      if (!result.configured) { await admin.from("notification_outbox").update({ status: "pending", scheduled_for: new Date(now.getTime() + 60 * 60 * 1000).toISOString(), last_error: "vapid_not_configured", updated_at: now.toISOString() }).eq("id", row.id); deferred += 1; }
      else if (result.sent > 0) { await admin.from("notification_outbox").update({ status: "sent", sent_at: now.toISOString(), last_error: null, updated_at: now.toISOString() }).eq("id", row.id); sent += 1; }
      else if (result.failed > 0) { await admin.from("notification_outbox").update({ status: "pending", scheduled_for: new Date(now.getTime() + Math.min(6 * 60, 2 ** Math.min(row.attempt_count, 8)) * 60_000).toISOString(), last_error: "push_delivery_failed", updated_at: now.toISOString() }).eq("id", row.id); failed += 1; }
      else { await admin.from("notification_outbox").update({ status: "cancelled", last_error: "no_active_subscription", updated_at: now.toISOString() }).eq("id", row.id); cancelled += 1; }
    } catch (error) { await admin.from("notification_outbox").update({ status: "pending", scheduled_for: new Date(now.getTime() + Math.min(6 * 60, 2 ** Math.min(row.attempt_count, 8)) * 60_000).toISOString(), last_error: error instanceof Error ? error.message.slice(0, 500) : "dispatch_failed", updated_at: now.toISOString() }).eq("id", row.id); failed += 1; }
  }
  return { evaluated: pending.length, sent, failed, deferred, cancelled };
}
