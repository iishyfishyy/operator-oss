# Releasing Operator

Operator is distributed as source through GitHub Releases. A release tag must point to the
reviewed commit on `main`.

## Prepare a release

1. Update the version in `package.json`.
2. Add the dated entry to `CHANGELOG.md`.
3. Add the GitHub release body at `docs/releases/vX.Y.Z.md`.
4. Run `npm run preflight`.
5. Open and merge the release pull request.

Create a private draft release during review so the final GitHub page can be checked without
publishing a tag:

```bash
gh release create vX.Y.Z \
  --draft \
  --target main \
  --title "Operator vX.Y.Z" \
  --notes-file docs/releases/vX.Y.Z.md
```

## Publish from main

```bash
git switch main
git pull --ff-only origin main
git status --short
git tag -a vX.Y.Z -m "Operator vX.Y.Z"
git push origin vX.Y.Z
gh release edit vX.Y.Z --draft=false
```

Use `git tag -s` instead when signed tags are configured. Confirm the release page, source
archives, and README release badge after publishing.

## Patch a release

Fix the issue on a branch from `main`, increment the patch version, update the changelog and
release notes, and repeat the same flow. Do not move or replace a published tag.
