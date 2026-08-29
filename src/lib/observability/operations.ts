import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

type AdminClient = SupabaseClient;
type AlertRule = { id: string; name: string; metric: string; comparator: "gt" | "gte" | "lt" | "lte" | "eq"; threshold: number; window_minutes: number; severity: "info" | "warning" | "error" | "critical"; metadata: Record<string, unknown> | null };

function compare(value: number, comparator: AlertRule["comparator"], threshold: number) {
  if (comparator === "gt") return value > threshold;
  if (comparator === "gte") return value >= threshold;
  if (comparator === "lt") return value < threshold;
  if (comparator === "lte") return value <= threshold;
  return value === threshold;
}

async function metricValue(admin: AdminClient, rule: AlertRule) {
  const since = new Date(Date.now() - rule.window_minutes * 60_000).toISOString();
  if (rule.metric === "generation_failed") return (await admin.from("generation_jobs").select("id", { count: "exact", head: true }).eq("status", "failed").gte("updated_at", since)).count ?? 0;
  if (rule.metric === "generation_active") return (await admin.from("generation_jobs").select("id", { count: "exact", head: true }).in("status", ["queued","generating","persisting","retrying"])).count ?? 0;
  if (rule.metric === "telemetry_errors") return (await admin.from("telemetry_events").select("id", { count: "exact", head: true }).in("severity", ["error","critical"]).gte("occurred_at", since)).count ?? 0;
  if (rule.metric === "realtime_reconnects") return (await admin.from("telemetry_events").select("id", { count: "exact", head: true }).eq("event_name", "realtime.reconnecting").gte("occurred_at", since)).count ?? 0;
  if (rule.metric === "audio_failures") return (await admin.from("question_audio_assets").select("id", { count: "exact", head: true }).eq("status", "failed").gte("updated_at", since)).count ?? 0;
  if (rule.metric === "fairness_compromised") return (await admin.from("question_fairness_assessments").select("question_id", { count: "exact", head: true }).eq("decision", "compromised").gte("assessed_at", since)).count ?? 0;
  if (rule.metric === "privacy_pending") return (await admin.from("data_requests").select("id", { count: "exact", head: true }).in("status", ["queued","processing"])).count ?? 0;
  throw new Error(`Unsupported operational metric: ${rule.metric}`);
}

export async function evaluateOperationalAlerts(admin: AdminClient) {
  const { data: rules, error } = await admin.from("operational_alert_rules").select("id, name, metric, comparator, threshold, window_minutes, severity, metadata").eq("enabled", true);
  if (error) throw error;
  const evaluated: { ruleId: string; metric: string; value: number; triggered: boolean }[] = [];
  for (const raw of rules ?? []) {
    const rule = { ...raw, threshold: Number(raw.threshold) } as AlertRule;
    const value = await metricValue(admin, rule);
    const triggered = compare(value, rule.comparator, rule.threshold);
    const fingerprint = `rule:${rule.id}`;
    if (triggered) {
      const { data: existing } = await admin.from("operational_alerts").select("id, occurrence_count").eq("fingerprint", fingerprint).maybeSingle();
      const alert = {
        rule_id: rule.id,
        fingerprint,
        metric: rule.metric,
        observed_value: value,
        threshold: rule.threshold,
        severity: rule.severity,
        title: rule.name,
        detail: `${rule.metric} = ${value} (${rule.comparator} ${rule.threshold}) trong ${rule.window_minutes} phút`,
        context: rule.metadata ?? {},
        status: "open",
        last_seen_at: new Date().toISOString(),
        occurrence_count: (existing?.occurrence_count ?? 0) + 1,
        acknowledged_by: null,
        acknowledged_at: null,
        resolved_by: null,
        resolved_at: null
      };
      if (existing) await admin.from("operational_alerts").update(alert).eq("id", existing.id);
      else await admin.from("operational_alerts").insert(alert);
    } else {
      await admin.from("operational_alerts").update({ status: "resolved", resolved_at: new Date().toISOString(), last_seen_at: new Date().toISOString() }).eq("rule_id", rule.id).in("status", ["open","acknowledged"]);
    }
    evaluated.push({ ruleId: rule.id, metric: rule.metric, value, triggered });
  }
  return evaluated;
}

export async function getOperationsSnapshot(admin: AdminClient) {
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  const [activeJobs, failedJobs, errors, reconnects, audioFailures, fairness, pendingPrivacy, oldestJob, recentEvents, jobs, alerts, rules] = await Promise.all([
    admin.from("generation_jobs").select("id", { count: "exact", head: true }).in("status", ["queued","generating","persisting","retrying"]),
    admin.from("generation_jobs").select("id", { count: "exact", head: true }).eq("status", "failed").gte("updated_at", dayAgo),
    admin.from("telemetry_events").select("id", { count: "exact", head: true }).in("severity", ["error","critical"]).gte("occurred_at", hourAgo),
    admin.from("telemetry_events").select("id", { count: "exact", head: true }).eq("event_name", "realtime.reconnecting").gte("occurred_at", hourAgo),
    admin.from("question_audio_assets").select("id", { count: "exact", head: true }).eq("status", "failed").gte("updated_at", dayAgo),
    admin.from("question_fairness_assessments").select("question_id", { count: "exact", head: true }).eq("decision", "compromised").gte("assessed_at", dayAgo),
    admin.from("data_requests").select("id", { count: "exact", head: true }).in("status", ["queued","processing"]),
    admin.from("generation_jobs").select("created_at").in("status", ["queued","generating","persisting","retrying"]).order("created_at").limit(1).maybeSingle(),
    admin.from("telemetry_events").select("id, event_name, severity, duration_ms, provider, model, error_code, error_message, metadata, occurred_at").order("occurred_at", { ascending: false }).limit(100),
    admin.from("generation_jobs").select("id, status, stage, total_rounds, completed_rounds, attempt_count, max_attempts, error_code, error_message, created_at, updated_at, rooms(code)").order("created_at", { ascending: false }).limit(30),
    admin.from("operational_alerts").select("id, rule_id, metric, observed_value, threshold, severity, title, detail, status, first_seen_at, last_seen_at, occurrence_count").order("last_seen_at", { ascending: false }).limit(50),
    admin.from("operational_alert_rules").select("id, name, metric, comparator, threshold, window_minutes, severity, enabled, created_at").order("created_at", { ascending: false })
  ]);
  const oldestAgeSeconds = oldestJob.data?.created_at ? Math.max(0, Math.round((Date.now() - new Date(oldestJob.data.created_at).getTime()) / 1000)) : 0;
  return {
    checkedAt: new Date().toISOString(),
    metrics: {
      activeGenerationJobs: activeJobs.count ?? 0,
      failedGenerationJobs24h: failedJobs.count ?? 0,
      telemetryErrors1h: errors.count ?? 0,
      realtimeReconnects1h: reconnects.count ?? 0,
      audioFailures24h: audioFailures.count ?? 0,
      compromisedRounds24h: fairness.count ?? 0,
      pendingPrivacyRequests: pendingPrivacy.count ?? 0,
      oldestActiveJobSeconds: oldestAgeSeconds
    },
    recentEvents: recentEvents.data ?? [],
    jobs: jobs.data ?? [],
    alerts: alerts.data ?? [],
    rules: rules.data ?? []
  };
}
