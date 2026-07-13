# Contributing

Thanks for your interest in Orchestrator!

## Getting started

```bash
npm install
npm run dev    # app on :3000, pty sidecar on 127.0.0.1:3001
npm test       # vitest — serial on purpose (tests spawn real git subprocesses)
```

`CLAUDE.md` is the codebase map (architecture, conventions, gotchas) — read it
before a nontrivial change. TypeScript is strict; there is no lint script.

## Ground rules

- **One change per PR**, with a commit message that explains the *why*, not
  just the what.
- **Tests**: bug fixes come with a regression test; behavior changes update the
  affected tests. `npm test` must be green.
- **README.md stays current** — if you change user-visible behavior, update it
  in the same PR.
- **Env-driven config**: a new per-instance knob is an env var with a
  documented default, added to `lib/config.ts` (or `lib/features.ts` for
  flags) **and** `.env.example`.

## Developer Certificate of Origin

Contributions are accepted under the [Developer Certificate of
Origin](https://developercertificate.org/). By adding a `Signed-off-by` line
to your commits (`git commit -s`), you certify you have the right to submit
the work under this repository's license (Apache-2.0).
