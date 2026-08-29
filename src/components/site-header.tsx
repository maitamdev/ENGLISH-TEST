import Link from "next/link";
import { LogIn } from "lucide-react";
import { Brand } from "./brand";

export function SiteHeader({ app = false, displayName }: { app?: boolean; displayName?: string }) {
  return (
    <header className="topbar" suppressHydrationWarning>
      <div className="app-container topbar-inner" suppressHydrationWarning>
        <Brand />
        <nav className="nav-links" aria-label="Main navigation">
          {app ? (
            <>
              <Link href="/dashboard">Dashboard</Link>
              <Link href="/review">Review</Link>
              <Link href="/study">Study</Link>
              <Link href="/progress">Progress</Link>
              <Link href="/paths">Paths</Link>
              <Link href="/speaking">Speaking</Link>
              <Link href="/community">Community</Link>
              <Link href="/profile">Profile</Link>
            </>
          ) : (
            <>
              <Link href="/#how-it-works">How it works</Link>
              <Link href="/#privacy">Privacy</Link>
            </>
          )}
        </nav>
        <div className="topbar-actions">
          {app ? (
            <Link className="button button-secondary" href="/profile">{displayName || "Profile"}</Link>
          ) : (
            <Link className="button button-secondary" href="/login"><LogIn size={17} /> Sign in</Link>
          )}
        </div>
      </div>
    </header>
  );
}
