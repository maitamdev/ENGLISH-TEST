import Link from "next/link";
import { Database, ExternalLink } from "lucide-react";

export function ConfigRequired() {
  return (
    <main className="config-page">
      <section className="surface config-required">
        <Database size={30} className="text-accent" />
        <h1>Connect Supabase to continue.</h1>
        <p>LexiDuel does not create fallback users, rooms, scores, questions, or learning history.</p>
        <ol>
          <li>Run <code>supabase/schema.sql</code> in the Supabase SQL Editor.</li>
          <li>Set <code>NEXT_PUBLIC_SUPABASE_URL</code> and <code>NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY</code>.</li>
          <li>Restart the development server.</li>
        </ol>
        <Link className="button button-secondary" href="https://supabase.com/dashboard" target="_blank">Open Supabase <ExternalLink size={16} /></Link>
      </section>
    </main>
  );
}
