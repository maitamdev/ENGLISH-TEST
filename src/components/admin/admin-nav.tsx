import Link from "next/link";
import { Activity, Database, FlaskConical, LayoutDashboard, ShieldAlert } from "lucide-react";

export function AdminNav({ active }: { active: "home" | "content" | "evals" | "operations" | "safety" }) {
  const links = [
    { id: "home", href: "/admin", label: "Overview", icon: LayoutDashboard },
    { id: "content", href: "/admin/content", label: "Content", icon: Database },
    { id: "evals", href: "/admin/ai-evals", label: "AI Evals", icon: FlaskConical },
    { id: "operations", href: "/admin/operations", label: "Operations", icon: Activity },
    { id: "safety", href: "/admin/safety", label: "Safety", icon: ShieldAlert }
  ] as const;
  return <nav className="admin-nav" aria-label="Platform administration">{links.map((item) => <Link key={item.id} href={item.href} aria-current={active === item.id ? "page" : undefined} className={active === item.id ? "active" : ""}><item.icon size={16} />{item.label}</Link>)}</nav>;
}
