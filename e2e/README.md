# End-to-end suite

Playwright tests that boot the **real production server** (`npm start` — `server.js`
+ the pty sidecar, exactly what a self-hoster runs) against a **throwaway
instance** and drive the app the way a user does: through the browser and the
public REST routes. One command before pushing:

```bash
npm run preflight     # vitest unit suite + build + full e2e run
```

or just the e2e half:

```bash
npm run test:e2e        # next build + playwright test
npm run test:e2e:only   # skip the rebuild — ONLY safe if app code didn't change
npx playwright test e2e/03-views.spec.ts   # one spec (post-01 specs self-onboard)
```

## How it stays hermetic and deterministic

- **Fresh instance per run** — `e2e/env.ts` creates a temp root (DB, worktrees,
  projects, fixture repos, pinned gitconfig) and points every `ORCH_*` dir at it.
  Nothing touches `~/.zen-orchestrator` or your real projects; the app listens on
  port 4711 (`ORCH_E2E_PORT` to move it). Analytics are disabled.
- **No real agent needed** — the suite sets `ORCH_E2E_MOCK_AGENT=1`, which
  registers the deterministic mock driver (`lib/agents/mock/driver.ts`) in the
  agent registry. It implements the full `AgentDriver` contract — instant login,
  verify, streamed turns (session/model/tool/assistant/usage/done), commits its
  work like a real agent — so onboarding, turns, diffs, and merges all run
  end-to-end with zero credentials and identical output every time.
- **Scripted turns** — mock behavior is driven by directives embedded in the
  prompt (title/description for the initial turn, message text after):

  | Directive | Effect |
  |-|-|
  | `e2e:write=<relpath>:<content>` | write that file in the task worktree |
  | `e2e:sleep=<ms>` | hold the turn open (Stop / queueing tests) |
  | `e2e:fail=<message>` | end the turn with an error event |
  | `e2e:suggest=<title>` | file a suggested task the way the real drivers do: a `suggest_task` tool card whose result carries the created id (so the transcript's suggestion chip renders), then the `suggested` event; one per line for a batch |
  | `e2e:ask=<question>\|<opt>\|<opt>` | park on an AskUserQuestion card until answered (a Stop dismisses it), then run the rest — so `e2e:ask=… e2e:sleep=3000` keeps working 3s after the answer |
  | *(none)* | append the prompt to `AGENT_NOTES.md` (so every turn has a diff) |

## Specs

| File | Covers |
|-|-|
| `01-onboarding.spec.ts` | first-run wizard: connect agent → verify → tutorial seeded (must run first — needs the untouched fresh DB) |
| `02-core-flow.spec.ts` | the core loop through the UI: new project → new task → session runs → transcript streams → diff → merge to main → file really lands on the base branch |
| `03-views.spec.ts` | list ⇄ board (kanban) toggle, status columns, card placement |
| `04-turn-behaviors.spec.ts` | mid-turn queueing, Stop, failed-turn notices, suggestions tray + the transcript's suggestion chips (rename / dismiss / Add, the "Suggested this session" block), session resume |
| `05-api-smoke.spec.ts` | REST contracts: diff/sync shapes, `/clear` generation lineage, agent registry, hard deletes |
| `06-conflict-banner.spec.ts` | live conflict banner clears after unstaged manual resolution or a completed mock chat turn, survives reload, and allows the resolved work to merge |

`07-commands.spec.ts` covers preset creation/edit/deletion, slash-menu keyboard navigation,
expanded transcript messages, and command-palette insertion. The test environment enables
the optional command palette.

The suite runs serially (one shared app instance + SQLite DB). Every spec after
01 calls `ensureOnboarded()` in `beforeAll` and creates its own uniquely-named
project, so they're independently runnable.

## Adding coverage

- New UI flow → prefer role/title/placeholder selectors (the app has no
  `data-testid`s); scope title text to a container class when it renders in
  several places (list row, board card, session header).
- New agent-visible behavior → add a directive to the mock driver rather than
  special-casing a spec.
- Changed `lib/` or `app/` code → re-run `npm run test:e2e` (not `:only`): the
  server executes the **built** bundle, so a stale `.next` will test old code.
