import Link from "next/link";
import { redirect } from "next/navigation";
import { Activity, ArrowRight, BookOpenCheck, Database, FlaskConical, ShieldAlert, ShieldCheck } from "lucide-react";
import { AdminNav } from "@/components/admin/admin-nav";
import { SiteHeader } from "@/components/site-header";
import { authorizePlatformAdmin } from "@/lib/admin/authorization";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const auth = await authorizePlatformAdmin();
  if (!auth.ok) redirect("/dashboard");
  const { data: profile } = await auth.admin.from("profiles").select("display_name").eq("id", auth.user.id).single();
  return <><SiteHeader app displayName={profile?.display_name} /><main className="page-shell"><div className="app-container"><AdminNav active="home" /><header className="page-header admin-hero"><div><span className="eyebrow"><ShieldCheck size={15} /> PLATFORM CONTROL</span><h1 className="page-title">Vận hành bằng bằng chứng.</h1><p className="page-lead">Không có số liệu minh họa. Mọi nguồn, lần chạy AI, cảnh báo và quyết định moderation đều đọc trực tiếp từ Supabase.</p></div><span className="admin-role">{auth.role}</span></header><div className="admin-launch-grid"><Link className="surface admin-launch" href="/admin/content"><Database /><div><h2>Content Studio</h2><p>Import nguồn được phép, kiểm tra provenance và duyệt nội dung.</p></div><ArrowRight /></Link><Link className="surface admin-launch" href="/admin/curriculum"><BookOpenCheck /><div><h2>Curriculum</h2><p>Quản lý CEFR descriptor, license, provenance và moderation.</p></div><ArrowRight /></Link><Link className="surface admin-launch" href="/admin/ai-evals"><FlaskConical /><div><h2>AI Quality Gate</h2><p>Tạo case thật, chạy model thật và giữ lịch sử chất lượng.</p></div><ArrowRight /></Link><Link className="surface admin-launch" href="/admin/operations"><Activity /><div><h2>Operations</h2><p>Theo dõi job, fairness, lỗi provider và alert bền vững.</p></div><ArrowRight /></Link><Link className="surface admin-launch" href="/admin/safety"><ShieldAlert /><div><h2>Trust &amp; Safety</h2><p>Điều tra báo cáo thật, phân công và lưu quyết định moderation.</p></div><ArrowRight /></Link></div></div></main></>;
}
