"use client";

import { createBrowserClient } from "@supabase/ssr";

export function getSupabaseBrowserConfig() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  return url && key ? { url, key } : null;
}

export function createSupabaseBrowserClient() {
  const config = getSupabaseBrowserConfig();
  if (!config) return null;
  return createBrowserClient(config.url, config.key);
}
