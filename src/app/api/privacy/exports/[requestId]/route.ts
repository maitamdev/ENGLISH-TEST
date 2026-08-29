import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function GET(_request: Request, { params }: { params: Promise<{ requestId: string }> }) {
  const { requestId } = await params;
  if (!z.string().uuid().safeParse(requestId).success) return NextResponse.json({ error: "Yêu cầu không hợp lệ" }, { status: 400 });
  const supabase = await createSupabaseServerClient();
  const admin = createSupabaseAdminClient();
  if (!supabase || !admin) return NextResponse.json({ error: "Supabase chưa được cấu hình" }, { status: 503 });
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return NextResponse.json({ error: "Bạn cần đăng nhập" }, { status: 401 });
  const { data: row } = await admin.from("data_requests").select("storage_path, status, expires_at").eq("id", requestId).eq("user_id", authData.user.id).eq("request_type", "export").maybeSingle();
  if (!row) return NextResponse.json({ error: "Không tìm thấy bản xuất dữ liệu" }, { status: 404 });
  if (row.status !== "ready" || !row.storage_path || !row.expires_at || new Date(row.expires_at).getTime() <= Date.now()) return NextResponse.json({ error: "Bản xuất chưa sẵn sàng hoặc đã hết hạn" }, { status: 409 });
  const { data, error } = await admin.storage.from("user-exports").createSignedUrl(row.storage_path, 60);
  if (error || !data) return NextResponse.json({ error: error?.message ?? "Không tạo được liên kết tải" }, { status: 500 });
  return NextResponse.redirect(data.signedUrl, 303);
}
