# Merge artifacts

Merge artifacts downloads two artifacts from the same run, stores one new zip, deletes each source manifest and then its blob, and returns `artifact-id`, `artifact-digest`, and `artifact-url`.

## Sub-features

- `merge-two-files` stores `left.txt` and `right.txt` in one zip.
- `delete-merged` removes each source manifest after the merged manifest exists, then deletes that source blob best-effort.

## How to get to it (user POV)

- In a job that already uploaded `side-left` and `side-right`, add `uses: toyamagu-2021/github-s3-artifact/merge@v0` with `name: merged-sides`, `pattern: side-*`, and `delete-merged: true`.
- From this checkout, run the same step with `uses: ./merge`. That entry runs `dist/merge/index.js`.

## Driving it with verify-github-s3-artifact

Preconditions:

- Doctor prints `doctor ok` for this state.
- This state has no manifests matching `side-*` or named `merged-sides`.

- **Place the files.** Write `merge-src/left.txt` containing `left-body` and a trailing newline, and `merge-src/right.txt` containing `right-body` and a trailing newline. The helper does this inside the scratch workspace.
- **Upload both.** The helper runs `dist/upload/index.js` twice, with `INPUT_NAME=side-left` and `INPUT_NAME=side-right`. Both exit `0`.
- **Merge.** Run `node .cursor/skills/verify-github-s3-artifact/scripts/verify.mjs drive merge-artifacts`. The bundle is `dist/merge/index.js` with `INPUT_NAME=merged-sides`, `INPUT_PATTERN=side-*`, and `INPUT_DELETE-MERGED=true`. Exit code is `0`. Stdout contains `2 artifact(s) have been deleted`.
- **Read the outputs.** `github-output.txt` has `artifact-id` as a decimal integer, `artifact-digest` as 64 hex characters, and `artifact-url` as `s3://verify-artifacts/verify/verify-org/verify-repo/runs/<run-id>/blobs/<artifact-id>`.
- **Read the merged object.** The manifest key is `verify/verify-org/verify-repo/runs/<run-id>/manifests/merged-sides.json`. Its `digest` is `sha256:` plus the output digest. The blob sha256 equals the output digest. The zip contains `left.txt` and `right.txt` with those workspace bytes.
- **Read the deletions.** HeadObject for the `side-left` and `side-right` manifest keys returns not found. `objects.json` lists those keys in `deletedManifests`.

## Gotchas

- `pattern` matches artifact names in the current run, not file paths.
- `delete-merged` removes the manifest first, then deletes the source blob best-effort. A reader that lists manifests no longer sees the source after the manifest delete. A blob delete that fails does not fail the step.
- A single-file upload stores the basename. The merged zip contains `left.txt`, not `merge-src/left.txt`.
- Run this drive once per launch. `merged-sides` stays reserved on that run id (the source manifests `side-left` and `side-right` are deleted by `delete-merged: true`).
