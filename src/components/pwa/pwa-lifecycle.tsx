"use client";

import { useEffect, useState } from "react";
import { Bell, Download, RefreshCw, WifiOff, X } from "lucide-react";

type InstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

function decodeVapidKey(value: string) {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const raw = window.atob((value + padding).replace(/-/gu, "+").replace(/_/gu, "/"));
  return Uint8Array.from([...raw].map((character) => character.charCodeAt(0)));
}

export function PwaLifecycle() {
  const [online, setOnline] = useState(true);
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const [updateReady, setUpdateReady] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [notificationState, setNotificationState] = useState<NotificationPermission | "unsupported">("unsupported");

  useEffect(() => {
    queueMicrotask(() => {
      setOnline(navigator.onLine);
      if ("Notification" in window) setNotificationState(Notification.permission);
    });
    const becameOnline = () => { setOnline(true); window.dispatchEvent(new CustomEvent("lexiduel:app-resume")); };
    const becameOffline = () => setOnline(false);
    const install = (event: Event) => { event.preventDefault(); setInstallPrompt(event as InstallPromptEvent); };
    const visibility = () => { if (document.visibilityState === "visible") window.dispatchEvent(new CustomEvent("lexiduel:app-resume")); };
    window.addEventListener("online", becameOnline); window.addEventListener("offline", becameOffline);
    window.addEventListener("beforeinstallprompt", install); document.addEventListener("visibilitychange", visibility);
    if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js", { scope: "/" }).then((registration) => {
      if (registration.waiting) setUpdateReady(true);
      registration.addEventListener("updatefound", () => registration.installing?.addEventListener("statechange", () => { if (registration.waiting) setUpdateReady(true); }));
    }).catch(() => undefined);
    return () => { window.removeEventListener("online", becameOnline); window.removeEventListener("offline", becameOffline); window.removeEventListener("beforeinstallprompt", install); document.removeEventListener("visibilitychange", visibility); };
  }, []);

  async function install() {
    if (!installPrompt) return;
    await installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(null);
  }

  async function enableNotifications() {
    const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
    if (!publicKey || !("serviceWorker" in navigator) || !("PushManager" in window)) return;
    const permission = await Notification.requestPermission();
    setNotificationState(permission);
    if (permission !== "granted") return;
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: decodeVapidKey(publicKey) });
    await fetch("/api/push/subscriptions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(subscription.toJSON()) });
  }

  if (dismissed && online && !updateReady) return null;
  return <aside className="pwa-status" aria-live="polite">
    {!online && <div className="pwa-offline"><WifiOff size={16} /><span><strong>Đang ngoại tuyến</strong> Câu trả lời sẽ chỉ gửi khi kết nối trở lại.</span></div>}
    {online && updateReady && <button onClick={() => window.location.reload()}><RefreshCw size={15} /> Có bản mới · tải lại</button>}
    {online && installPrompt && <button onClick={() => void install()}><Download size={15} /> Cài LexiDuel</button>}
    {online && notificationState === "default" && process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY && <button onClick={() => void enableNotifications()}><Bell size={15} /> Bật nhắc lịch học</button>}
    {online && (updateReady || installPrompt || notificationState === "default") && <button className="pwa-dismiss" onClick={() => setDismissed(true)} aria-label="Ẩn thông báo"><X size={14} /></button>}
  </aside>;
}
