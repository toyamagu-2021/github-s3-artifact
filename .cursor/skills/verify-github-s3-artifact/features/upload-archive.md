# Upload an archived artifact

Upload an archived artifact stores the selected file in a zip, writes the blob before the manifest, and returns `artifact-id`, `artifact-digest`, and `artifact-url`.

## Sub-features

- `upload-one-file` stores a single file at the zip root and emits the three outputs.
- `upload-stored-objects` leaves a blob and a manifest whose digest, size, and key match those outputs.

## How to get to it (user POV)

- In a job that already has S3 credentials and `S3_ARTIFACT_*` variables, add `uses: toyamagu-2021/github-s3-artifact/upload@v0` with `name: build-dist` and `path: dist-fixture/app.txt`.
- From this checkout, run the same step with `uses: ./upload`. That entry runs `dist/upload/index.js`.

## Driving it with verify-github-s3-artifact

Preconditions:

- Doctor prints `doctor ok` for this state.
- This state has no manifest named `build-dist`.

- **Place the file.** Write `dist-fixture/app.txt` containing `hello from verify` and a trailing newline. The helper does this inside the scratch workspace.
- **Upload.** Run `node .cursor/skills/verify-github-s3-artifact/scripts/verify.mjs drive upload-archive`. The bundle is `dist/upload/index.js` with `INPUT_NAME=build-dist` and `INPUT_PATH=dist-fixture/app.txt`. Exit code is `0`. Stdout contains `Artifact 'build-dist' uploaded`.
- **Read the outputs.** `github-output.txt` has `artifact-id` as a decimal integer, `artifact-digest` as 64 hex characters, and `artifact-url` as `s3://verify-artifacts/verify/verify-org/verify-repo/runs/<run-id>/blobs/<artifact-id>`.
- **Read the objects.** The manifest key is `verify/verify-org/verify-repo/runs/<run-id>/manifests/build-dist.json`. Its `digest` is `sha256:` plus the output digest. Its `size` equals the blob `ContentLength`. The blob sha256 equals the output digest. The blob ETag and size are in `objects.json`.
- **Read the zip.** The stored object contains `app.txt` and does not contain `dist-fixture/app.txt`. The entry bytes are `hello from verify` plus a newline. The workspace file is unchanged.

## Gotchas

- A single file path drops the parent directory. Assert `app.txt`, not `dist-fixture/app.txt`.
- Dotfiles are excluded unless the workflow sets `include-hidden-files: true`.
- Run this drive once per launch. A second upload of `build-dist` on the same run attempt fails when overwrite is false.
- The digest is the sha256 of the zip bytes, not the sha256 of `app.txt`.
