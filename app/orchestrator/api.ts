// Tiny fetch helpers used throughout the orchestrator client.

// Routes report failures as JSON `{ error }` — unwrap that so surfaced messages
// read "worktree is dirty", not a raw JSON blob (transcript system errors, modal
// error notes and ErrNote all show this string verbatim).
async function fail(r: Response): Promise<never> {
  const raw = await r.text();
  let msg = raw || `${r.status} ${r.statusText}`;
  try {
    const j = JSON.parse(raw);
    if (typeof j?.error === "string" && j.error) msg = j.error;
  } catch { /* not JSON — keep the raw body */ }
  throw new Error(msg);
}

export async function jget<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) await fail(r);
  return r.json();
}
export async function jsend<T>(url: string, method: string, body?: unknown): Promise<T> {
  const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) await fail(r);
  return r.json();
}
