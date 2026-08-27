import Image from "next/image";
import Link from "next/link";
import { ArrowRight, Bot, Gamepad2, LockKeyhole, Mic2, Radio, ShieldCheck, Sparkles, Users2 } from "lucide-react";
import { SiteHeader } from "@/components/site-header";

export default function HomePage() {
  return (
    <>
      <SiteHeader />
      <main suppressHydrationWarning>
        <section className="landing-hero" suppressHydrationWarning>
          <div className="app-container hero-grid" suppressHydrationWarning>
            <div className="hero-copy reveal">
              <h1>Speak.<br />Learn.<br /><span>Compete.</span></h1>
              <p>A private English room where two friends talk naturally, then give an AI host a custom brief for a live battle.</p>
              <div className="hero-actions">
                <Link className="button button-primary" href="/create-room"><Users2 size={18} /> Create a room</Link>
                <Link className="button button-secondary" href="/join-room">Join with code <ArrowRight size={18} /></Link>
              </div>
              <div className="hero-privacy"><ShieldCheck size={15} /> Human voice stays peer to peer and is never recorded by default.</div>
            </div>
            <div className="hero-visual reveal" style={{ animationDelay: "120ms" }}>
              <div className="hero-orbit" />
              <div className="hero-preview">
                <Image src="/images/product-board.png" alt="LexiDuel room, battle and result interface previews" width={1536} height={1024} priority />
              </div>
              <div className="hero-float one"><Radio size={17} className="text-accent" /> Voice connected</div>
              <div className="hero-float two"><Sparkles size={17} className="text-accent" /> AI host ready</div>
            </div>
          </div>
        </section>

        <section className="proof-strip" aria-label="Product principles">
          <div className="app-container proof-grid">
            <div><strong>Made for two friends</strong></div>
            <div><Mic2 size={20} className="text-accent" /><span><strong>Realtime voice</strong>P2P conversation</span></div>
            <div><Bot size={20} className="text-accent" /><span><strong>AI game host</strong>Your custom brief</span></div>
            <div><Gamepad2 size={20} className="text-accent" /><span><strong>Fair competition</strong>Server-scored rounds</span></div>
          </div>
        </section>

        <section className="landing-section" id="how-it-works">
          <div className="app-container">
            <div className="section-copy">
              <h2>No lesson menus.<br />Just start talking.</h2>
              <p>Enter one room, speak with your friend, and create a custom match only when both of you are ready.</p>
            </div>
            <div className="steps-grid">
              <article className="surface step-primary">
                <div><Radio size={28} className="text-accent" /></div>
                <div><h3>Talk freely in your private voice room.</h3><p>Your audio travels directly between both players. The AI stays paused until you ask it to join.</p></div>
              </article>
              <div className="step-stack">
                <article className="surface step-secondary"><Bot size={25} className="text-accent" /><div><h3>Describe the battle</h3><p>Type the topic, level, and question style you want in natural language.</p></div></article>
                <article className="surface step-secondary"><Gamepad2 size={25} className="text-accent" /><div><h3>Compete and review</h3><p>Play fast rounds, compare answers, and learn what to practice next.</p></div></article>
              </div>
            </div>
          </div>
        </section>

        <section className="landing-section" id="privacy">
          <div className="app-container surface privacy-panel">
            <div className="privacy-visual">
              <div className="privacy-line" />
              <div className="privacy-nodes"><Users2 size={78} className="text-accent" /><LockKeyhole size={54} /></div>
            </div>
            <div className="privacy-copy">
              <LockKeyhole size={28} className="text-accent" />
              <h2>Your room stays yours.</h2>
              <p>Human conversation uses WebRTC. The AI generator receives the typed match request, not your room audio.</p>
              <ul className="privacy-list">
                <li><ShieldCheck size={18} className="text-accent" /> No default voice recording</li>
                <li><ShieldCheck size={18} className="text-accent" /> Private room codes</li>
                <li><ShieldCheck size={18} className="text-accent" /> Answers stay server-side</li>
              </ul>
            </div>
          </div>
        </section>

        <section className="app-container surface landing-cta">
          <div><h2>Ready for your first duel?</h2><p className="page-lead">Create a room and invite one friend. It takes less than a minute.</p></div>
          <Link className="button button-primary" href="/create-room">Create a room <ArrowRight size={18} /></Link>
        </section>
      </main>
    </>
  );
}
