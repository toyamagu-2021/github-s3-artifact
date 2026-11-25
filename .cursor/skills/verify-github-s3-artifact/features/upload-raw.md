# Upload a raw file

Upload a raw file stores one file unchanged when `archive` is false. The artifact name is the file basename. The `name` input is ignored.

## Sub-features

- `upload-raw-bytes` stores the file bytes as the blob and reports their sha256.
- `upload-raw-name` uses the basename and does not create an artifact under the `name` input.

## How to get to it (user POV)

- Add `uses: toyamagu-2021/github-s3-artifact/upload@v0` with `name: ignored-name`, `path: single-dir/app.tar.gz`, and `archive: false`.
- From this checkout, the same step is `uses: ./upload`.

## Driving it with verify-github-s3-artifact

Preconditions:

- Doctor prints `doctor ok` for this state.
- This state has no manifest named `app.tar.gz`.

- **Place the file.** Write `single-dir/app.tar.gz` containing `raw-payload` and a trailing newline.
- **Upload.** Run `node .cursor/skills/verify-github-s3-artifact/scripts/verify.mjs drive upload-raw`. The bundle receives `INPUT_NAME=ignored-name`, `INPUT_PATH=single-dir/app.tar.gz`, and `INPUT_ARCHIVE=false`. Exit code is `0`.
- **Read the outputs.** `artifact-digest` equals the sha256 of the file bytes. `artifact-url` points at the blob key from the manifest.
- **Read the objects.** The manifest name is `app.tar.gz`, `archived` is false, and `contentType` is `application/gzip`. The blob bytes equal the file. No manifest exists for `ignored-name`. Record the blob key, ETag, and size.

## Gotchas

- Two or more matches with `archive: false` fail before upload.
- `path.extname` of `app.tar.gz` is `.gz`, so the stored content type is `application/gzip`.
- The ignored `name` input must not appear as an object key.
