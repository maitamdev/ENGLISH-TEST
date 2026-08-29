import { redirect } from "next/navigation";
import { AdminNav } from "@/components/admin/admin-nav";
import { AiEvalConsole } from "@/components/admin/ai-eval-console";
import { SiteHeader } from "@/components/site-header";
import { authorizePlatformAdmin } from "@/lib/admin/authorization";

export const dynamic = "force-dynamic";

export default async function AiEvalsPage() {
  const auth = await authorizePlatformAdmin();
  if (!auth.ok) redirect("/dashboard");
  const { data: profile } = await auth.admin.from("profiles").select("display_name").eq("id", auth.user.id).single();
  return <><SiteHeader app displayName={profile?.display_name} /><main className="page-shell"><div className="app-container"><AdminNav active="evals" /><AiEvalConsole canEdit={auth.role === "owner" || auth.role === "admin"} /></div></main></>;
}
