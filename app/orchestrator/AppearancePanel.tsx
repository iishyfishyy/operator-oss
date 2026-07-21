"use client";

import { Icon } from "../icons";
import type { Appearance } from "./types";

export function AppearancePanel({ appearance, setAppearance, onClose }: { appearance: Appearance; setAppearance: (k: keyof Appearance, v: string) => void; onClose: () => void }) {
  const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontFamily: "var(--mono)", fontSize: 10, fontWeight: 700, letterSpacing: ".07em", textTransform: "uppercase", color: "var(--ink-3)", marginBottom: 8 }}>{label}</div>
      {children}
    </div>
  );
  return (
    <div className="modal" style={{ position: "fixed", right: 16, bottom: 16, width: 264, zIndex: 300, animation: "pop .16s ease" }}>
      <div className="modal-h" style={{ padding: "14px 16px 12px" }}>
        <div className="m-title" style={{ fontSize: 15, flex: 1, display: "flex", alignItems: "center", gap: 8 }}>{Icon.sliders()} Appearance</div>
        <button className="modal-close" onClick={onClose}>{Icon.x()}</button>
      </div>
      <div className="modal-b" style={{ padding: 16 }}>
        <Row label="Mode">
          <div className="seg">
            <button className={appearance.theme === "light" ? "on" : ""} onClick={() => setAppearance("theme", "light")}>{Icon.sun()} Light</button>
            <button className={appearance.theme === "dark" ? "on" : ""} onClick={() => setAppearance("theme", "dark")}>{Icon.moon()} Dark</button>
          </div>
        </Row>
        <Row label={`Density · ${appearance.density === "1" ? "comfortable" : "compact"}`}>
          <div className="seg">
            <button className={appearance.density === "1" ? "on" : ""} onClick={() => setAppearance("density", "1")}>Comfortable</button>
            <button className={appearance.density === "0.72" ? "on" : ""} onClick={() => setAppearance("density", "0.72")}>Compact</button>
          </div>
        </Row>
      </div>
    </div>
  );
}
