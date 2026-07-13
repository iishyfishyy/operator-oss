"use client";

import { useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import type { Terminal as XTerm } from "@xterm/xterm";
import type { FitAddon as FitAddonType } from "@xterm/addon-fit";

const darkTheme = {
  background: "#15140f", foreground: "#E8E2D4", cursor: "#E0A07F",
  selectionBackground: "#3A2B22", black: "#15140f", brightBlack: "#5E594E",
  red: "#E0685D", green: "#8FBE82", yellow: "#DCB458", blue: "#6FA8CF",
  magenta: "#C58FC4", cyan: "#79B8B0", white: "#E8E2D4", brightWhite: "#FBFAF6",
};
const lightTheme = {
  background: "#FBFAF6", foreground: "#26241F", cursor: "#C2603C",
  selectionBackground: "#F0D9CE", black: "#26241F", brightBlack: "#928D80",
  red: "#C0503C", green: "#5C8C5A", yellow: "#9A6E14", blue: "#3E7CA8",
  magenta: "#9E5BA0", cyan: "#3E7CA8", white: "#605C52", brightWhite: "#26241F",
};

// Imperative handle the mobile terminal sheet uses to feed input (paste, Enter,
// Ctrl-C buttons) without owning the websocket itself.
export interface TermApi { send: (data: string) => void; }

export function TerminalView({ cwd, port, fontSize = 12.5, onReady }: { cwd: string; port?: number; fontSize?: number; onReady?: (api: TermApi) => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddonType | null>(null);
  // Bumping this tears down the dead xterm/socket and spawns a fresh shell.
  const [session, setSession] = useState(0);
  // Read the latest font size at shell-creation time without making it an effect
  // dep (which would respawn the shell on every zoom); live changes apply below.
  const fontRef = useRef(fontSize);
  fontRef.current = fontSize;

  useEffect(() => {
    let term: XTerm | null = null;
    let fit: FitAddonType | null = null;
    let ws: WebSocket | null = null;
    let ro: ResizeObserver | null = null;
    let disposed = false;
    let dead = false; // shell gone (exit or sidecar drop) — awaiting Enter to respawn

    (async () => {
      const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/addon-web-links"),
      ]);
      if (disposed || !hostRef.current) return;

      const dark = document.documentElement.getAttribute("data-theme") === "dark";
      term = new Terminal({
        fontFamily: "'JetBrains Mono', ui-monospace, monospace",
        fontSize: fontRef.current,
        lineHeight: 1.25,
        cursorBlink: true,
        scrollback: 8000,
        theme: dark ? darkTheme : lightTheme,
      });
      fit = new FitAddon();
      term.loadAddon(fit);
      // Tappable links — the whole point of the mobile terminal's login flow is
      // opening the OAuth URL Claude prints, so route clicks/taps to a new tab.
      term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri, "_blank", "noopener,noreferrer")));
      term.open(hostRef.current);
      termRef.current = term;
      fitRef.current = fit;
      try { fit.fit(); } catch {}

      // The Next server proxies /pty to the local node-pty sidecar, so one
      // hostname carries both (works behind a tunnel). PUBLIC_BASE_URL (injected
      // by the layout) overrides the origin when the instance's public address
      // differs from what the browser sees; empty = same origin as the app.
      const baseUrl = (window as { __PUBLIC_BASE_URL?: string }).__PUBLIC_BASE_URL || window.location.origin;
      const wsBase = baseUrl.replace(/^http/, "ws");
      const portQ = port && port > 0 ? `&port=${port}` : "";
      const url = `${wsBase}/pty?cwd=${encodeURIComponent(cwd)}&cols=${term.cols}&rows=${term.rows}${portQ}`;
      ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";

      ws.onmessage = (e) => {
        if (typeof e.data === "string") {
          try {
            const m = JSON.parse(e.data);
            if (m.type === "exit") term!.write(`\r\n\x1b[90m[process exited (${m.exitCode})]\x1b[0m\r\n`);
          } catch {}
        } else {
          term!.write(new Uint8Array(e.data));
        }
      };
      ws.onerror = () => { if (!disposed) term!.write(`\r\n\x1b[31m[terminal unreachable — is the pty-server sidecar running?]\x1b[0m\r\n`); };
      ws.onclose = () => {
        if (disposed) return;
        dead = true;
        term!.write("\r\n\x1b[90m[disconnected — press Enter to start a new shell]\x1b[0m\r\n");
      };

      // Single input path for both typed keystrokes and the mobile button-bar:
      // when the shell is dead, Enter respawns it; otherwise forward to the pty.
      const send = (d: string) => {
        if (dead) {
          if (d === "\r") setSession((s) => s + 1);
          return;
        }
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "input", data: d }));
      };
      term.onData(send);
      onReady?.({ send });

      const syncSize = () => {
        if (!hostRef.current || hostRef.current.clientHeight < 24) return; // skip when collapsed
        try {
          fit!.fit();
          if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resize", cols: term!.cols, rows: term!.rows }));
        } catch {}
      };
      ro = new ResizeObserver(syncSize);
      ro.observe(hostRef.current);
      term.focus();
    })();

    return () => {
      disposed = true;
      termRef.current = null;
      fitRef.current = null;
      try { ro?.disconnect(); } catch {}
      try { ws?.close(); } catch {}
      try { term?.dispose(); } catch {}
    };
  }, [cwd, session]);

  // Live font-size changes (mobile A−/A+) without respawning the shell: retheme
  // the existing terminal and refit so the pty's cols/rows track the new metrics.
  useEffect(() => {
    const t = termRef.current;
    if (!t) return;
    t.options.fontSize = fontSize;
    try { fitRef.current?.fit(); } catch {}
  }, [fontSize]);

  return <div className="term-host" ref={hostRef} />;
}
