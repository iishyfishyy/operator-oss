"use client";

import { Icon } from "../icons";
import type { Tweaks } from "./types";

export function TweaksPanel({ tweaks, setTweak, onClose }: { tweaks: Tweaks; setTweak: (k: keyof Tweaks, v: string) => void; onClose: () => void }) {
  const accents = ["#4d8cff", "#5b9dff", "#ff6a45", "#38d39f", "#a78bfa", "#f5a623"];
  const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontFamily: "var(--mono)", fontSize: 10, fontWeight: 700, letterSpacing: ".07em", textTransform: "uppercase", color: "var(--ink-3)", marginBottom: 8 }}>{label}</div>
      {children}
    </div>
  );
  return (
    <div className="modal" style={{ position: "fixed", right: 16, bottom: 16, width: 264, zIndex: 300, animation: "pop .16s ease" }}>
      <div className="modal-h" style={{ padding: "14px 16px 12px" }}>
        <div className="m-title" style={{ fontSize: 15, flex: 1, display: "flex", alignItems: "center", gap: 8 }}>{Icon.sliders()} Tweaks</div>
        <button className="modal-close" onClick={onClose}>{Icon.x()}</button>
      </div>
      <div className="modal-b" style={{ padding: 16 }}>
        <Row label="Theme">
          <div className="seg">
            <button className={tweaks.theme === "light" ? "on" : ""} onClick={() => setTweak("theme", "light")}>{Icon.sun()} Light</button>
            <button className={tweaks.theme === "dark" ? "on" : ""} onClick={() => setTweak("theme", "dark")}>{Icon.moon()} Dark</button>
          </div>
        </Row>
        <Row label="Accent">
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button onClick={() => setTweak("accent", "default")} title="Theme default" style={{ width: 30, height: 26, borderRadius: 7, background: "var(--accent)", border: "1px solid var(--line-strong)", cursor: "pointer", outline: tweaks.accent === "default" ? "2px solid var(--ink)" : "none", outlineOffset: 2, fontSize: 11, color: "var(--on-accent)" }}>A</button>
            {accents.map((c) => (
              <button key={c} onClick={() => setTweak("accent", c)} style={{ width: 30, height: 26, borderRadius: 7, background: c, border: "none", cursor: "pointer", outline: tweaks.accent === c ? "2px solid var(--ink)" : "none", outlineOffset: 2 }} />
            ))}
          </div>
        </Row>
        <Row label={`Density · ${tweaks.density === "1" ? "comfortable" : "compact"}`}>
          <div className="seg">
            <button className={tweaks.density === "1" ? "on" : ""} onClick={() => setTweak("density", "1")}>Comfortable</button>
            <button className={tweaks.density === "0.72" ? "on" : ""} onClick={() => setTweak("density", "0.72")}>Compact</button>
          </div>
        </Row>
        <Row label="Status style">
          <div className="seg">
            <button className={tweaks.statusStyle === "dot" ? "on" : ""} onClick={() => setTweak("statusStyle", "dot")}>Dots</button>
            <button className={tweaks.statusStyle === "label" ? "on" : ""} onClick={() => setTweak("statusStyle", "label")}>Dots + label</button>
          </div>
        </Row>
      </div>
    </div>
  );
}
