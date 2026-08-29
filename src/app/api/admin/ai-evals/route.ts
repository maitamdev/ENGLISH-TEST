import { NextResponse } from "next/server";
import { z } from "zod";
import { authorizePlatformAdmin } from "@/lib/admin/authorization";
import { generateQuestionEvaluationCandidate } from "@/lib/ai/durable-game-generator";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const mutationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create_case"), name: z.string().trim().min(3).max(120), suite: z.string().trim().min(2).max(80), input: z.record(z.string(), z.unknown()), expectations: z.record(z.string(), z.unknown()), tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]) }),
  z.object({ action: z.literal("run_case"), caseId: z.string().uuid() }),
  z.object({ action: z.literal("toggle_case"), caseId: z.string().uuid(), enabled: z.boolean() })
]);

function expectationChecks(expectations: Record<string, unknown>, output: Awaited<ReturnType<typeof generateQuestionEvaluationCandidate>>) {
  const checks: { code: string; passed: boolean; detail: string }[] = [];
  const requiredModes = Array.isArray(expectations.requiredModes) ? expectations.requiredModes.filter((value): value is string => typeof value === "string") : [];
  const forbiddenTerms = Array.isArray(expectations.forbiddenTerms) ? expectations.forbiddenTerms.filter((value): value is string => typeof value === "string") : [];
  const dump = JSON.stringify(output.questions).toLocaleLowerCase("vi-VN");
  if (requiredModes.length) checks.push({ code: "required_modes", passed: requiredModes.every((mode) => output.questions.some((question) => question.mode === mode)), detail: `Required: ${requiredModes.join(", ")}` });
  if (forbiddenTerms.length) checks.push({ code: "forbidden_terms", passed: forbiddenTerms.every((term) => !dump.includes(term.toLocaleLowerCase("vi-VN"))), detail: `Forbidden: ${forbiddenTerms.join(", ")}` });
  const minimum = typeof expectations.minimumQuality === "number" ? Math.max(0, Math.min(1, expectations.minimumQuality)) : 0.86;
  checks.push({ code: "minimum_quality", passed: output.quality.score >= minimum, detail: `${output.quality.score} >= ${minimum}` });
  checks.push({ code: "quality_gate", passed: output.quality.passed, detail: `${output.quality.checks.filter((check) => !check.passed).length} failed checks` });
  return checks;
}

export async function GET() {
  const auth = await authorizePlatformAdmin();
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const [cases, runs] = await Promise.all([
    auth.admin.from("ai_evaluation_cases").select("id, name, suite, case_type, input, expectations, tags, enabled, created_at, updated_at").order("created_at", { ascending: false }).limit(100),
    auth.admin.from("ai_evaluation_runs").select("id, suite, provider, model, status, total_cases, passed_cases, failed_cases, aggregate_score, started_at, completed_at, error_message, created_at, ai_evaluation_results(id, case_id, passed, score, checks, latency_ms, error_message)").order("created_at", { ascending: false }).limit(30)
  ]);
  const error = cases.error ?? runs.error;
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ cases: cases.data ?? [], runs: runs.data ?? [] }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: Request) {
  const auth = await authorizePlatformAdmin(["owner", "admin"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const parsed = mutationSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid evaluation action", details: parsed.error.flatten() }, { status: 400 });
  if (parsed.data.action === "create_case") {
    const { data, error } = await auth.admin.from("ai_evaluation_cases").insert({
      name: parsed.data.name,
      suite: parsed.data.suite,
      input: parsed.data.input,
      expectations: parsed.data.expectations,
      tags: parsed.data.tags,
      case_type: "question_batch",
      created_by: auth.user.id
    }).select("id").single();
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json(data, { status: 201 });
  }
  if (parsed.data.action === "toggle_case") {
    const { error } = await auth.admin.from("ai_evaluation_cases").update({ enabled: parsed.data.enabled, updated_at: new Date().toISOString() }).eq("id", parsed.data.caseId);
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ enabled: parsed.data.enabled });
  }

  const { data: evaluationCase } = await auth.admin.from("ai_evaluation_cases").select("id, name, suite, input, expectations, enabled").eq("id", parsed.data.caseId).maybeSingle();
  if (!evaluationCase || !evaluationCase.enabled) return NextResponse.json({ error: "Enabled evaluation case not found" }, { status: 404 });
  const model = process.env.GROQ_MODEL ?? "unconfigured";
  const { data: run, error: runError } = await auth.admin.from("ai_evaluation_runs").insert({ suite: evaluationCase.suite, provider: "groq", model, status: "running", total_cases: 1, started_at: new Date().toISOString(), requested_by: auth.user.id }).select("id").single();
  if (runError || !run) return NextResponse.json({ error: runError?.message ?? "Could not start evaluation" }, { status: 400 });
  const started = Date.now();
  try {
    const output = await generateQuestionEvaluationCandidate(evaluationCase.input);
    const checks = expectationChecks(evaluationCase.expectations as Record<string, unknown>, output);
    const passed = checks.every((check) => check.passed);
    const score = checks.length ? checks.filter((check) => check.passed).length / checks.length : output.quality.score;
    await auth.admin.from("ai_evaluation_results").insert({ run_id: run.id, case_id: evaluationCase.id, passed, score, checks, output, latency_ms: Date.now() - started });
    await auth.admin.from("ai_evaluation_runs").update({ status: "completed", passed_cases: passed ? 1 : 0, failed_cases: passed ? 0 : 1, aggregate_score: score, completed_at: new Date().toISOString() }).eq("id", run.id);
    return NextResponse.json({ runId: run.id, passed, score, checks, output });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Evaluation failed";
    await auth.admin.from("ai_evaluation_results").insert({ run_id: run.id, case_id: evaluationCase.id, passed: false, score: 0, checks: [], latency_ms: Date.now() - started, error_message: message });
    await auth.admin.from("ai_evaluation_runs").update({ status: "failed", failed_cases: 1, aggregate_score: 0, error_message: message, completed_at: new Date().toISOString() }).eq("id", run.id);
    return NextResponse.json({ error: message, runId: run.id }, { status: 502 });
  }
}
