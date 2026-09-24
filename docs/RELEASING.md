# Releasing Operator

Operator is distributed as source through GitHub Releases, not npm. Keep the process
manual: one version bump, a short changelog, and an annotated tag on a reviewed `main`
commit. No release service or commit-message convention is required.

## When to push

Push reviewed work to `main` after `npm run preflight` passes; do not wait for a release
to back up integrated work. A push does not publish a release. Cut a release when there
is a useful set of user-facing changes and the release candidate passes the same gate.
While Operator is pre-1.0, use a minor bump for a feature batch and a patch bump for fixes.
Call out any breaking changes explicitly.

For v0.2.0, include all integrated changes since v0.1.0. Prepare and review the release
changes on a task branch, then merge them into local `main`. Validate that resulting
commit before pushing the accumulated work. Do not tag a task branch or rewrite the
existing history to make release notes prettier.

## Prepare the version and notes

Fetch remote state and inspect both the unpushed work and the complete release range:

```bash
git fetch origin --tags
git rev-list --left-right --count origin/main...HEAD
git log --first-parent --oneline v0.1.0..HEAD
git diff --stat v0.1.0..HEAD
```

Use the previous release tag for notes, not `origin/main`: some unreleased changes may
already have been pushed. The first-parent log avoids listing task commits twice, but
inspect the diff too. Summarize outcomes in about 5–8 bullets, group related fixes,
and omit task IDs, merge noise, and internal refactors. Include upgrade requirements.
GitHub's generated notes can be a checklist, but the edited changelog is authoritative.

1. Run `npm version 0.2.0 --no-git-tag-version` (substitute the next version in future).
   This updates both `package.json` and `package-lock.json` without creating a tag.
2. Add the version's entry to `CHANGELOG.md`, marked `Unreleased` during preparation.
3. Copy the concise bullets into `docs/releases/v0.2.0.md`, with any upgrade notes.
4. Review and integrate the release changes into `main` through the usual task merge or PR.

## Validate and publish

Run these commands from the checkout that owns `main`, after review and integration.
Before committing the release, replace `Unreleased` with the intended publication date
in `CHANGELOG.md`. If publication slips, update the date before tagging.

```bash
git switch main
git fetch origin --tags
git merge --ff-only origin/main
git status --short
npm ci --include=dev
npm run preflight
```

The worktree must be clean and preflight must pass. If the branches have diverged,
reconcile and review them before proceeding; never force-push. Any subsequent change
to the candidate requires validation again. Then push main and its tag together:

```bash
git tag -a v0.2.0 -m "Operator v0.2.0"
git push --atomic origin main refs/tags/v0.2.0
gh release create v0.2.0 \
  --verify-tag \
  --draft \
  --title "Operator v0.2.0" \
  --notes-file docs/releases/v0.2.0.md
```

Use `git tag -s` instead when signed tags are configured. The atomic push publishes
both refs or neither; if rejected, resolve the cause before retrying. A pushed tag is
public even while the GitHub release is a draft. `--verify-tag` prevents GitHub from
silently creating a tag at the wrong commit.

Review the draft's notes and target, then publish:

```bash
gh release edit v0.2.0 --draft=false --latest
```

Confirm the release page, source archives, and README release badge. Do not move or
replace a published tag. For the next release, substitute its version and previous tag
in these commands and repeat the same process.
