# Presigned artifact URL

Presigned artifact URL keeps `s3://` as the default and, when requested, puts a signed GetObject URL in `artifact-url`.

## Sub-features

- `presigned-get` returns a URL whose body is the uploaded zip.

## How to get to it (user POV)

- Add `artifact-url-format: presigned` and optional `presign-expires-seconds` to `uses: toyamagu-2021/github-s3-artifact/upload@v0`.
- From this checkout, `uses: ./upload` runs `dist/upload/index.js`.

## Driving it with verify-github-s3-artifact

Preconditions:

- Doctor prints `doctor ok` for this state.
- This state has no manifest named `presigned-one`.

- **Place the file.** Write `dist-fixture/app.txt` containing `hello from verify` and a trailing newline.
- **Upload.** Run `node .cursor/skills/verify-github-s3-artifact/scripts/verify.mjs drive presigned-url`. Inputs are `name=presigned-one`, `path=dist-fixture/app.txt`, `artifact-url-format=presigned`, and `presign-expires-seconds=120`. Exit code is `0`.
- **Read the URL.** `artifact-url` starts with `http` and contains `/blobs/<artifact-id>`. It is not an `s3://` URI. On this MinIO endpoint the scheme is `http`. AWS endpoints sign `https`.
- **Download the URL.** `GET` that URL returns HTTP 200. The body sha256 equals `artifact-digest`. The zip entry `app.txt` matches the workspace file.

## Gotchas

- The default format stays `s3://`. This drive opts in.
- The signature expires after 120 seconds in this recipe.
- The URL contains the credential signature. The evidence summary records the scheme, not the query string.
