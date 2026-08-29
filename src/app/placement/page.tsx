import { Gauge } from "lucide-react";
import { ConfigRequired } from "@/components/config-required";
import { PlacementExperience } from "@/components/placement/placement-experience";
import { SiteHeader } from "@/components/site-header";
import { requireAuthenticatedUser } from "@/lib/supabase/auth";

export const dynamic = "force-dynamic";

export default async function PlacementPage() {
  const { configured, supabase, user } = await requireAuthenticatedUser();
  if (!configured || !supabase || !user) return <ConfigRequired />;
  const { data: profile } = await supabase.from("profiles").select("display_name").eq("id", user.id).single();
  return <><SiteHeader app displayName={profile?.display_name} /><main className="page-shell"><div className="app-container"><header className="page-header"><div><span className="eyebrow"><Gauge size={15} /> ADAPTIVE DIAGNOSTIC</span><h1 className="page-title">Ước lượng trình độ bằng bằng chứng.</h1><p className="page-lead">Câu tiếp theo thích ứng theo câu trả lời trước. Kết quả có confidence và sai số đo lường, không tự nhận là chứng chỉ CEFR chính thức.</p></div></header><PlacementExperience /></div></main></>;
}
