# Release Builds

GitHub Actions builds and publishes the downloadable desktop installers. The
workflow is defined in `.github/workflows/build.yml` and is triggered whenever
a `v*` tag is pushed.

## Release checklist

1. Update the version in both `package.json` and the root package entry in
   `package-lock.json`.
2. Add accurate user-facing notes under a new version heading in `README.md`.
   Update the current-release link in its **Download** section.
3. Update the release body in `.github/workflows/build.yml` when the new
   release needs different GitHub Release notes.
4. Run the checks:

   ```bash
   rtk git diff --check
   rtk test npm test
   ```

5. Commit the release files, push `main`, then create and push the matching
   annotated tag:

   ```bash
   rtk git add package.json package-lock.json README.md .github/workflows/build.yml
   rtk git commit -m "chore: prepare vX.Y.Z release"
   rtk git push origin main
   rtk git tag -a vX.Y.Z -m "Release vX.Y.Z"
   rtk git push origin vX.Y.Z
   ```

6. Confirm that the **Build and Release** workflow succeeds for Windows,
   macOS, Linux, and the final `release` job. Then verify the GitHub Release
   contains the expected `.exe`, `.dmg`, and `.AppImage` downloads.

## Publishing guardrail

Electron Builder must only create artifacts in the three platform build jobs.
The `electron:build*` scripts include `--publish never`; do not remove it and
do not add `GH_TOKEN` to the platform build steps. On a tagged build,
Electron Builder otherwise attempts to publish concurrently and can fail with
`Resource not accessible by integration` or a missing-token error.

The dedicated `release` job has `contents: write` and is the only job that
creates the GitHub Release and uploads the platform artifacts.

## Retry policy

If a tagged release run fails, fix the cause, bump to the next patch version,
and publish a new tag. Do not force-move or delete a published release tag
without explicit user approval.
