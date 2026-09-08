"use client";
import { useState } from "react";
import type { CustomCommand } from "@/lib/types";
import { Modal } from "./Modal";
import { jsend } from "./api";
import { useCommands } from "./useCommands";

export function CommandsModal({ projectId, onClose }: { projectId?: string; onClose: () => void }) {
  const { commands, error: loadError, loading } = useCommands(projectId);
  const empty = { name: "", description: "", body: "", project_id: projectId ?? null };
  const [draft, setDraft] = useState(empty);
  const [id, setId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const reset = () => { setId(null); setDraft(empty); setError(""); };
  const edit = (c: CustomCommand) => { setId(c.id); setDraft({ name: c.name, description: c.description, body: c.body, project_id: c.project_id }); setError(""); };
  const mutate = async (deleting = false) => {
    setBusy(true); setError("");
    try {
      await jsend(`/api/commands${deleting ? `?id=${encodeURIComponent(id!)}` : ""}`, deleting ? "DELETE" : id ? "PATCH" : "POST", deleting ? undefined : { ...draft, ...(id ? { id } : {}) });
      window.dispatchEvent(new Event("orch:commands-changed"));
      reset();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return <Modal title="Manage commands" sub="Reusable prompts · project commands override app-wide commands with the same name" onClose={onClose} width={680}
    footer={<>
      {id && <button className="btn btn-ghost" disabled={busy} onClick={() => mutate(true)}>Delete command</button>}
      <span className="spacer" /><button className="btn btn-ghost" onClick={onClose}>Done</button>
      <button className="btn btn-accent" disabled={busy || !draft.name || !draft.body.trim()} onClick={() => mutate()}>{busy ? "Saving…" : id ? "Save changes" : "Create command"}</button>
    </>}>
    {(error || loadError) && <div role="alert">{error || loadError}</div>}
    {loading && <p>Loading commands…</p>}
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
      <button className="btn btn-line btn-sm" disabled={busy} onClick={reset}>New command</button>
      {commands.map((c) => <button key={c.id} className={`btn ${id === c.id ? "btn-accent" : "btn-line"} btn-sm`} disabled={busy} onClick={() => edit(c)}>/{c.name} · {c.project_id ? "project" : "app-wide"}</button>)}
    </div>
    <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0 }}>
      <div className="field"><label className="lab" htmlFor="command-name">Name</label><input id="command-name" value={draft.name} placeholder="analyze-ai-comments" onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></div>
      <div className="field"><label className="lab" htmlFor="command-scope">Scope</label><select id="command-scope" value={draft.project_id ?? ""} onChange={(e) => setDraft({ ...draft, project_id: e.target.value || null })}><option value="">App-wide</option>{projectId && <option value={projectId}>This project</option>}</select></div>
      <div className="field"><label className="lab" htmlFor="command-description">Description</label><input id="command-description" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></div>
      <div className="field"><label className="lab" htmlFor="command-body">Prompt template</label><textarea id="command-body" rows={7} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} /><div className="hlp">Use {"{{args}}"}, {"{{task.title}}"}, or {"{{task.description}}"}. Arguments are appended if the template has no {"{{args}}"}. The transcript shows the expanded prompt.</div></div>
    </fieldset>
  </Modal>;
}
