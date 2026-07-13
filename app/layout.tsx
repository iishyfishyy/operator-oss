import type { Metadata, Viewport } from "next";
import "./globals.css";
import { PUBLIC_BASE_URL } from "@/lib/config";
import { resolveFeatures } from "@/lib/features";
import { posthogSnippet } from "@/lib/analytics";

export const metadata: Metadata = {
  title: "Operator — build, verify & host every app with agents",
  description: "Run parallel agent sessions across every project, host each app live under your own domain, and verify changes from any device.",
};

// viewport-fit=cover lets the app paint under the notch / home indicator so the
// titlebar and composer can claim that space with safe-area insets; the phone
// layout (single-column nav) lives behind a max-width media query in globals.css.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

// Render per request so PUBLIC_BASE_URL is read from the runtime environment,
// not baked in at build time — a prebuilt image stays relocatable via env only.
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" data-theme="dark">
      <head>
        {/* Critical CSS, inlined so it applies on first parse — before the external
            stylesheets finish loading. The app is a fixed-shell UI (and the landing
            scrolls inside its own fixed `.cp` container), so the document itself must
            never scroll. Without this, a slow stylesheet load lets the browser paint
            the full-height body once and flash a document scrollbar that vanishes the
            moment the real CSS lands. */}
        <style dangerouslySetInnerHTML={{ __html: "html,body{height:100%;margin:0;overflow:hidden}" }} />
        {/* Hand the instance's public origin to client code (Terminal builds its
            ws(s):// URL from it). Empty = same-origin via window.location. */}
        <script
          dangerouslySetInnerHTML={{ __html: `window.__PUBLIC_BASE_URL=${JSON.stringify(PUBLIC_BASE_URL)};window.__FEATURES=${JSON.stringify(resolveFeatures())};` }}
        />
        {/* PostHog product analytics — loads posthog-js, auto-identifies the
            instance to its control-plane account (if provisioned), and no-ops
            when POSTHOG_KEY isn't set. Fed from server env so no build-time key. */}
        {(() => {
          const snippet = posthogSnippet();
          return snippet ? <script dangerouslySetInnerHTML={{ __html: snippet }} /> : null;
        })()}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700;800&family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
