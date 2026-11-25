# Download by name

Download by name fetches one artifact from the same repository and run, checks its digest, and extracts it into the destination directory.

## Sub-features

- `download-named` extracts the zip for `build-dist` directly into `path`.
- `download-output` sets `download-path` to the absolute destination.

## How to get to it (user POV)

- After the upload job, add `uses: toyamagu-2021/github-s3-artifact/download@v0` with `name: build-dist` and `path: out/build-dist`.
- From this checkout, the same step is `uses: ./download`, which runs `dist/download/index.js`.

## Driving it with verify-github-s3-artifact

Preconditions:

- Doctor prints `doctor ok` for this state.
- `drive upload-archive` has already succeeded on this same state.
- If the `build-dist` manifest is absent, stop and report that unmet precondition. Do not upload from inside this recipe.

- **Download.** Run `node .cursor/skills/verify-github-s3-artifact/scripts/verify.mjs drive download-by-name`. The bundle receives `INPUT_NAME=build-dist` and `INPUT_PATH=out/build-dist`. Exit code is `0`. Stdout contains `Download artifact has finished successfully` and `Total of 1 artifact(s) downloaded`.
- **Read the output.** `download-path` is the absolute scratch path `out/build-dist`.
- **Read the file.** `<download-path>/app.txt` is `hello from verify` plus a newline. `<download-path>/build-dist` does not exist.

## Gotchas

- One named artifact extracts into `path`, not `path/<name>`.
- A missing name fails the step. Do not treat an empty directory as success.
- `repository` and `run-id` default from `GITHUB_REPOSITORY` and `GITHUB_RUN_ID` when the workflow does not pass them. The helper sets those variables. It does not evaluate `${{ github.repository }}` itself.
