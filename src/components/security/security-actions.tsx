"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut, LoaderCircle } from "lucide-react";
import { toast } from "sonner";

export function SecurityActions() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function revokeSessions() {
    if (!window.confirm("Đăng xuất tài khoản này trên tất cả thiết bị?")) return;
    setBusy(true);
    try {
      const response = await fetch("/api/security/sessions", { method: "DELETE" });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Không thể đăng xuất các thiết bị");
      router.replace("/login?message=sessions_revoked");
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Không thể đăng xuất các thiết bị");
      setBusy(false);
    }
  }
  return <button className="button button-secondary security-revoke" type="button" disabled={busy} onClick={revokeSessions}>{busy ? <LoaderCircle size={17} className="animate-spin" /> : <LogOut size={17} />} Đăng xuất mọi thiết bị</button>;
}
