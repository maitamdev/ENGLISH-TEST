import { EntryForm } from "@/components/entry-form";
import { EntryLayout } from "@/components/entry-layout";
import { ConfigRequired } from "@/components/config-required";
import { getSupabaseServerConfig } from "@/lib/supabase/server";

export default function LoginPage() { return getSupabaseServerConfig() ? <EntryLayout><EntryForm mode="login" /></EntryLayout> : <ConfigRequired />; }
