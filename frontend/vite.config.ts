import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";

const API = process.env.VITE_API_TARGET ?? "http://localhost:5001";
// One .env for the whole project, at the repository root. Only VITE_* names reach the browser.
const ENV_DIR = "..";

// In development the browser talks only to Vite, which forwards /api and the
// WebSocket to the backend. One origin means the session cookie just works.
export default defineConfig(({ mode }) => {
  // The public address of the site, for the canonical and Open Graph URLs in index.html.
  // A production build without it leaves those tags out, since they need an absolute URL.
  const siteUrl = (loadEnv(mode, ENV_DIR, "VITE_").VITE_SITE_URL || (mode === "production" ? "" : "http://localhost:5173")).replace(/\/$/, "");
  if (!siteUrl) console.warn("VITE_SITE_URL is not set: the canonical and Open Graph URL tags are left out.");
  process.env.VITE_SITE_URL = siteUrl;
  const dropSiteUrlTags: Plugin = {
    name: "drop-site-url-tags",
    transformIndexHtml: { order: "pre", handler: (html) => (siteUrl ? html : html.replace(/^.*%VITE_SITE_URL%.*\n/gm, "")) },
  };
  return {
    envDir: ENV_DIR,
    plugins: [react(), tailwindcss(), dropSiteUrlTags],
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        "/api": { target: API },
        "/uploads": { target: API },
        "/socket.io": { target: API, ws: true },
      },
    },
  };
});
