"use client";

import { useEffect, useState } from "react";
import { comparableLine, duplicateLines, promptDiff, type PromptCapture } from "@/lib/promptCaptureTypes";

const rawText = (c: PromptCapture) => c.systemAppend === undefined ? c.prompt :
  JSON.stringify({ systemPrompt: { type: "preset", preset: c.options.systemPreset, append: c.systemAppend }, prompt: c.prompt }, null, 2);

export function PromptInspector({ taskId, running }: { taskId: string; running: boolean }) {
  const [captures, setCaptures] = useState<PromptCapture[]>([]);
  const [selected, setSelected] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true); setError("");
    fetch(`/api/tasks/${encodeURIComponent(taskId)}/prompts`, { signal: abort.signal, cache: "no-store" })
      .then(async r => { if (!r.ok) throw new Error("Could not load prompt captures."); return r.json(); })
      .then((data: { captures: PromptCapture[] }) => { setCaptures(data.captures); setLoading(false); })
      .catch(e => { if (!abort.signal.aborted) { setError(e.message); setLoading(false); } });
    return () => abort.abort();
  }, [taskId, running, refresh]);
  const capture = captures.find(c => c.id === selected) ?? captures[0];
  const previous = capture && captures.slice(captures.indexOf(capture) + 1)
    .find(c => c.agent === capture.agent && c.job === capture.job && c.taskId === capture.taskId);
  const duplicates = capture ? duplicateLines([capture.systemAppend ?? "", capture.prompt].join("\n")) : new Set<string>();
  const download = () => {
    if (!capture) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(capture, null, 2)], { type: "application/json" }));
    const a = document.createElement("a"); a.href = url; a.download = `prompt-${capture.id}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <div className="rail-pad prompt-inspector">
    <p>Exact Operator inputs to the agent SDK. Runtime instructions, restored history, tool results, and full model requests are not captured here.</p>
    <button className="btn btn-line" onClick={() => setRefresh(n => n + 1)}>Refresh captures</button>
    {error && <p role="alert">{error}</p>}
    {loading ? <p>Loading captures…</p> : !capture ? <p>No captures yet. Run a turn with ORCH_DEBUG_PROMPTS=1 enabled. Earlier prompts cannot be reconstructed.</p> : <>
      <label>Captured submission<select value={capture.id} onChange={e => { setSelected(e.target.value); setCopied(false); }}>
        {captures.map(c => <option key={c.id} value={c.id}>{new Date(c.createdAt).toLocaleString()} · {c.agent} · {c.job}{!c.taskId ? " (project job)" : ""}</option>)}
      </select></label>
      <p>{capture.sessionId ? "Resumed session" : "Fresh session"}{capture.generation ? ` · Window ${capture.generation}` : ""} · {capture.prompt.length.toLocaleString()} prompt characters</p>
      <p>{duplicates.size ? `${duplicates.size} repeated lines highlighted below (matching line bodies of 40+ characters; ignores the Task details label).` : "No repeated lines of 40+ characters within this submission."}</p>
      {capture.sections.map((section, i) => <details key={i} open>
        <summary>{section.label} · {section.text.length.toLocaleString()} characters</summary>
        <pre>{section.text.split("\n").map((line, j, lines) => <span key={j}>{duplicates.has(comparableLine(line)) ? <mark>{line}</mark> : line}{j < lines.length - 1 ? "\n" : ""}</span>)}</pre>
      </details>)}
      <details><summary>Run details</summary><pre>{JSON.stringify({ agent: capture.agent, job: capture.job, sessionId: capture.sessionId, ...capture.options }, null, 2)}</pre></details>
      <details><summary>Raw SDK text inputs</summary><pre>{rawText(capture)}</pre></details>
      <button className="btn btn-line" onClick={async () => { try { await navigator.clipboard.writeText(rawText(capture)); setCopied(true); } catch { setError("Clipboard unavailable. Download the capture instead."); } }}>{copied ? "Copied" : "Copy raw inputs"}</button>{" "}
      <button className="btn btn-line" onClick={download}>Download JSON</button>
      <details><summary>Compare with previous submission</summary>{previous ? <>
        <p>Compared with {new Date(previous.createdAt).toLocaleString()} for this agent and job. Reuse between turns is separate from duplication within a submission.</p>
        {(previous.systemAppend !== undefined || capture.systemAppend !== undefined) && <>
          <p>System prompt append</p><pre>{promptDiff(previous.systemAppend ?? "", capture.systemAppend ?? "")}</pre>
        </>}
        <p>User prompt</p><pre>{promptDiff(previous.prompt, capture.prompt)}</pre>
      </> : <p>No earlier capture for this agent and job is retained.</p>}</details>
    </>}
    <p>Captures retain exact prompt content locally with a 7-day expiry (purged on capture or read), within a shared limit of 200 captures / 32 MiB. Captures over 8 MiB are skipped. Downloaded copies are yours to manage.</p>
  </div>;
}
