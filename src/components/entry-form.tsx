"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, LoaderCircle, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

export function EntryForm({ mode, initialCode = "" }: { mode: "login" | "create" | "join"; initialCode?: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState("");
  const [code, setCode] = useState(initialCode.toUpperCase().slice(0, 6));

  const content = {
    login: { title: "Welcome", body: "Continue with an anonymous Supabase session, or use Google if you configured that provider.", cta: "Continue as guest" },
    create: { title: "Create your room", body: "Give yourself a name, check your microphone, then invite one friend.", cta: "Create room" },
    join: { title: "Join your friend", body: "Enter the six-character code from your invitation link.", cta: "Join room" }
  }[mode];

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim()) return toast.error("Enter your display name.");
    if (mode === "join" && code.replace(/\s/g, "").length !== 6) return toast.error("Room codes contain 6 characters.");
    setLoading(true);
    const supabase = createSupabaseBrowserClient();
    if (!supabase) {
      setLoading(false);
      return toast.error("Supabase environment variables are missing.");
    }

    try {
      const { data: authData } = await supabase.auth.getUser();
      let user = authData.user;
      if (!user) {
        const result = await supabase.auth.signInAnonymously({ options: { data: { display_name: name.trim() } } });
        if (result.error) throw result.error;
        user = result.data.user;
      }
      if (!user) throw new Error("Supabase did not create a user session.");

      const { error: profileError } = await supabase.from("profiles").update({ display_name: name.trim(), updated_at: new Date().toISOString() }).eq("id", user.id);
      if (profileError) throw profileError;

      if (mode === "login") {
        router.push("/dashboard");
      } else if (mode === "create") {
        const { data, error } = await supabase.rpc("create_room");
        if (error) throw error;
        const room = Array.isArray(data) ? data[0] : data;
        if (!room?.code) throw new Error("Supabase did not return a room code.");
        router.push(`/room/${room.code}`);
      } else {
        const { data, error } = await supabase.rpc("join_room_by_code", { requested_code: code.toUpperCase() });
        if (error) throw error;
        const room = Array.isArray(data) ? data[0] : data;
        if (!room?.code) throw new Error("Supabase did not return the room.");
        router.push(`/room/${room.code}`);
      }
      router.refresh();
    } catch (error) {
      setLoading(false);
      toast.error(error instanceof Error ? error.message : "Could not create room.");
    }
  }

  return (
    <div className="entry-form">
      <Sparkles className="text-accent" size={26} />
      <h2>{content.title}</h2>
      <p>{content.body}</p>
      <form className="form-stack" onSubmit={submit}>
        <div className="field">
          <label htmlFor="display-name">Display name</label>
          <input className="input" id="display-name" value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" maxLength={40} />
          <small>This is what your friend and Lexi will call you.</small>
        </div>
        {mode === "join" && (
          <div className="field">
            <label htmlFor="room-code">Room code</label>
            <input className="input code-input" id="room-code" value={code} onChange={(event) => setCode(event.target.value.slice(0, 6))} maxLength={6} autoCapitalize="characters" />
          </div>
        )}
        <button className="button button-primary button-wide" disabled={loading}>
          {loading ? <LoaderCircle size={18} className="animate-spin" /> : <>{content.cta}<ArrowRight size={18} /></>}
        </button>
      </form>
      {mode === "login" && <><div className="divider">or</div><button className="button button-secondary button-wide" onClick={async () => {
        const supabase = createSupabaseBrowserClient();
        if (!supabase) return toast.error("Supabase environment variables are missing.");
        const redirectTo = `${window.location.origin}/auth/callback?next=/dashboard`;
        const { error } = await supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo } });
        if (error) toast.error(error.message);
      }}>Continue with Google</button></>}
    </div>
  );
}
