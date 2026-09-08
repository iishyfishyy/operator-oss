"use client";
import { useState } from "react";
import type { CustomCommand } from "@/lib/types";
import { Icon } from "../icons";
import { Modal } from "./Modal";
import { jsend } from "./api";
import { ErrNote, Skel } from "./shared";
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
  // A command is either app-wide or scoped to one project. Editing a foreign
  // project's command from the app-wide modal keeps its original project id.
  const scoped = draft.project_id !== null;
  const canScope = !!projectId || scoped;
  return <Modal title="Manage commands" sub="Reusable prompts · project commands override app-wide commands with the same name" onClose={onClose} width={680}
    footer={<>
      {id && <button className="btn-danger" disabled={busy} onClick={() => mutate(true)} title={`Permanently remove /${draft.name}`}>{Icon.x()} Delete command</button>}
      <span className="spacer" /><button className="btn btn-ghost" onClick={onClose}>Done</button>
      <button className="btn btn-accent" disabled={busy || !draft.name || !draft.body.trim()} onClick={() => mutate()}>{busy ? "Saving…" : id ? <>{Icon.check()} Save changes</> : <>{Icon.plus()} Create command</>}</button>
    </>}>
    {(error || loadError) && <ErrNote style={{ marginBottom: 16 }}>{error || loadError}</ErrNote>}
    <div className="field">
      <div className="lab">Saved commands <span className="opt">— pick one to edit</span></div>
      <div className="cmd-picker">
        <button className={`btn btn-line btn-sm${id === null ? " on" : ""}`} disabled={busy} onClick={reset}>{Icon.plus()} New command</button>
        {loading && commands.length === 0 && [88, 104, 72].map((w, i) => <Skel key={i} w={w} h={28} r={6} />)}
        {commands.map((c) => (
          <button key={c.id} className={`btn btn-line btn-sm cmd-chip${id === c.id ? " on" : ""}`} disabled={busy} onClick={() => edit(c)} title={c.description || `/${c.name}`}>
            <span className="nm">/{c.name}</span><span className="sc">· {c.project_id ? "project" : "app-wide"}</span>
          </button>
        ))}
      </div>
      {!loading && commands.length === 0 && <div className="hlp">No commands yet — the one you create below shows up in the composer&apos;s slash menu.</div>}
    </div>
    <fieldset className="cmd-form" disabled={busy}>
      <div className="field">
        <label className="lab" htmlFor="command-name">Name</label>
        <input id="command-name" type="text" className="ctx-mono" value={draft.name} placeholder="analyze-ai-comments" onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        <div className="hlp">Lowercase letters, numbers and dashes. Typed as <span className="ctx-mono">/{draft.name || "name"}</span> in the composer.</div>
      </div>
      <div className="field">
        <div className="lab">Scope</div>
        <div className="seg">
          <button type="button" className={!scoped ? "on" : ""} onClick={() => setDraft({ ...draft, project_id: null })}>{Icon.spark()} App-wide</button>
          <button type="button" className={scoped ? "on" : ""} disabled={!canScope} title={canScope ? undefined : "Open this from a project to scope a command to it"} onClick={() => setDraft({ ...draft, project_id: projectId ?? draft.project_id })}>{Icon.folder()} This project</button>
        </div>
      </div>
      <div className="field">
        <label className="lab" htmlFor="command-description">Description</label>
        <input id="command-description" type="text" value={draft.description} placeholder="Analyze review feedback" onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
        <div className="hlp">Shown beside the command in the slash menu and the ⌘K palette.</div>
      </div>
      <div className="field">
        <label className="lab" htmlFor="command-body">Prompt template</label>
        <textarea id="command-body" className="cmd-body" rows={7} value={draft.body} placeholder={"Review {{task.title}} for correctness.\nFocus on: {{args}}"} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
        <div className="hlp">Use {"{{args}}"}, {"{{task.title}}"}, or {"{{task.description}}"}. Arguments are appended if the template has no {"{{args}}"}. The transcript shows the expanded prompt.</div>
      </div>
    </fieldset>
  </Modal>;
}
