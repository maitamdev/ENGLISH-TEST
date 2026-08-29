import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "LexiDuel · Học tiếng Anh cùng bạn bè",
    short_name: "LexiDuel",
    description: "Phòng học tiếng Anh hai người với Gemini Live, thi đấu realtime và ôn tập thích ứng.",
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    background_color: "#07090a",
    theme_color: "#c7f542",
    orientation: "any",
    categories: ["education", "productivity"],
    lang: "vi",
    icons: [{ src: "/images/lexi-host.png", sizes: "any", type: "image/png", purpose: "any" }]
  };
}
