import { Brand } from "./brand";
import Image from "next/image";

export function EntryLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="entry-page">
      <section className="entry-brand">
        <Brand />
        <div className="entry-brand-copy"><h1>One room.<br />Two voices.<br /><span className="text-accent">A better habit.</span></h1><p>Practice English with someone you already know. Lexi keeps the game moving when you are ready.</p></div>
        <div className="entry-art" aria-hidden="true"><div className="ai-avatar"><Image src="/images/lexi-host.png" alt="" fill sizes="126px" /></div></div>
      </section>
      <section className="entry-form-wrap">{children}</section>
    </main>
  );
}
