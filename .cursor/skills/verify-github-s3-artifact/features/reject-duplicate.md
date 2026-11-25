# Reject a duplicate name

Reject a duplicate name fails a second upload of the same artifact name in the same run attempt when `overwrite` is false, and leaves the first blob and manifest unchanged.

## Sub-features

- `duplicate-fail` exits with a duplicate error.
- `duplicate-preserved` keeps the first blob ETag, size, digest, and entry bytes.

## How to get to it (user POV)

- Upload `dup-check` with `uses: toyamagu-2021/github-s3-artifact/upload@v0`.
- Upload that name again in the same job attempt with `overwrite: false`, or omit `overwrite`.

## Driving it with verify-github-s3-artifact

Preconditions:

- Doctor prints `doctor ok` for this state.
- This state has no manifest named `dup-check`.

- **Upload the first file.** The helper writes `dup/payload.txt` as `first` plus a newline and uploads `name: dup-check`. Exit code is `0`. Record `artifact-id`, `artifact-digest`, the blob key, the blob ETag, and the blob size.
- **Change the workspace file.** Rewrite `dup/payload.txt` to `second` plus a newline.
- **Upload again.** Run `node .cursor/skills/verify-github-s3-artifact/scripts/verify.mjs drive reject-duplicate`. The second bundle invocation sets `INPUT_OVERWRITE=false`. Exit code is `1`. Stdout contains `already exists`.
- **Read the stored object.** The blob ETag and size match the first upload. The manifest digest is unchanged. The zip entry `payload.txt` is still `first` plus a newline.

## Gotchas

- `overwrite: true` is a different feature and is not this recipe.
- A higher `GITHUB_RUN_ATTEMPT` may replace the manifest even when overwrite is false. This recipe keeps `GITHUB_RUN_ATTEMPT=1`.
- Judge preservation from the object head and the zip entry, not from the second exit code alone.
