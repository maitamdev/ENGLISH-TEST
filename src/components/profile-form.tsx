"use client";

import { useState } from "react";
import { Save } from "lucide-react";
import { toast } from "sonner";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

export function ProfileForm({ userId, displayName, username }: { userId: string; displayName: string; username: string | null }) {
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState(displayName);
  const [handle, setHandle] = useState(username ?? "");

  async function save(event: React.FormEvent) {
    event.preventDefault();
    const supabase = createSupabaseBrowserClient();
    if (!supabase) return toast.error("Supabase is not configured.");
    setLoading(true);
    const { error } = await supabase.from("profiles").update({ display_name: name.trim(), username: handle.trim().toLowerCase() || null, updated_at: new Date().toISOString() }).eq("id", userId);
    setLoading(false);
    if (error) return toast.error(error.message);
    toast.success("Profile saved in Supabase.");
  }

  return <form className="settings-section" onSubmit={save}><h3>Personal details</h3><div className="settings-grid"><div className="field"><label htmlFor="profile-name">Display name</label><input id="profile-name" className="input" value={name} onChange={(event) => setName(event.target.value)} required maxLength={40} /></div><div className="field"><label htmlFor="profile-username">Username</label><input id="profile-username" className="input" value={handle} onChange={(event) => setHandle(event.target.value.replace(/[^a-zA-Z0-9_]/g, ""))} minLength={3} maxLength={24} /></div></div><div className="settings-section"><button className="button button-primary" disabled={loading}><Save size={18} /> {loading ? "Saving" : "Save changes"}</button></div></form>;
}
