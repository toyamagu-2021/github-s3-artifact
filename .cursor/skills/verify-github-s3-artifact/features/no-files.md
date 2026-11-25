# No matching files

No matching files is the upload step's response when `path` matches nothing. `if-no-files-found` chooses warn, error, or ignore. None of the three writes a manifest.

## Sub-features

- `no-files-warn` exits 0, emits `::warning::`, and writes no object. Warn is the default.
- `no-files-error` exits 1, emits `::error::`, and writes no object.
- `no-files-ignore` exits 0, does not emit `::warning::`, and writes no object.

## How to get to it (user POV)

- Point `uses: toyamagu-2021/github-s3-artifact/upload@v0` at a path that matches nothing.
- Set `if-no-files-found` to `warn`, `error`, or `ignore`. Omit it to get `warn`.

## Driving it with verify-github-s3-artifact

Preconditions:

- Doctor prints `doctor ok` for this state.

- **Warn.** Run `node .cursor/skills/verify-github-s3-artifact/scripts/verify.mjs drive no-files`. The warn invocation uses `INPUT_NAME=missing-warn`, `INPUT_PATH=missing-warn/**`, and `INPUT_IF-NO-FILES-FOUND=warn`. Exit code is `0`. Stdout contains `::warning::` and `No files were found with the provided path: missing-warn/**. No artifacts will be uploaded.` `GITHUB_OUTPUT` is empty. The manifest key for `missing-warn` is absent.
- **Error.** The same drive uses `missing-error` and `if-no-files-found: error`. Exit code is `1`. Stdout contains `::error::` and the same no-files sentence. The manifest key is absent.
- **Ignore.** The same drive uses `missing-ignore` and `if-no-files-found: ignore`. Exit code is `0`. Stdout contains the no-files sentence and does not contain `::warning::` for it. The manifest key is absent.

## Gotchas

- Warn still succeeds. A green step is not proof that an object was stored.
- The manifest key must be absent. An empty `GITHUB_OUTPUT` can also happen if the output file was reused from an earlier step, so the helper uses a fresh output file.
- `error` fails in the action process. It does not delete objects from a previous successful upload.
