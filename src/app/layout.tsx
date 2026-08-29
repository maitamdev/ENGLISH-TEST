import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Toaster } from "sonner";
import { PwaLifecycle } from "@/components/pwa/pwa-lifecycle";
import "./globals.css";

const geist = Geist({ subsets: ["latin", "vietnamese"], variable: "--font-sans" });
const mono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: { default: "LexiDuel", template: "%s | LexiDuel" },
  description: "A private English voice room where friends learn, speak, and compete with an AI host.",
  manifest: "/manifest.webmanifest",
  applicationName: "LexiDuel",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "LexiDuel" }
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="vi" className={`${geist.variable} ${mono.variable}`} suppressHydrationWarning>
      <body suppressHydrationWarning>
        <a className="skip-link" href="#main-content">Bỏ qua điều hướng</a>
        <div id="main-content" tabIndex={-1}>{children}</div>
        <PwaLifecycle />
        <Toaster theme="dark" position="top-center" richColors />
      </body>
    </html>
  );
}
