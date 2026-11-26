---
name: verify-github-s3-artifact
description: >-
  Drive the github-s3-artifact upload and download actions against a local
  MinIO server the way a workflow does. Run the built dist bundles, then
  check S3 objects and action outputs. Use when proving an upload, a
  download, or the stored artifact.
---

# Verify github-s3-artifact

Use this skill to prove the upload and download actions from a checkout of `toyamagu-2021/github-s3-artifact`. A workflow step `uses: toyamagu-2021/github-s3-artifact/upload@v0` runs `dist/upload/index.js`. `uses: toyamagu-2021/github-s3-artifact/download@v0` runs `dist/download/index.js`. This skill starts MinIO, runs those bundles with the same `INPUT_*` and `GITHUB_*` variables the runner sets, and reads the stored objects.

Two instances can run side by side. Each launch binds its own port, data directory, and `GITHUB_RUN_ID`. Pass `--state` to every later command for that instance. Do not drive a MinIO process this run did not start.

## Launch

From the repo root:

```bash
npm ci
npm run build
node .cursor/skills/verify-github-s3-artifact/scripts/verify.mjs launch
```

Launch is ready when it prints `VERIFY_STATE=`, `endpoint=http://127.0.0.1:<port>`, and `minio=RELEASE.2025-09-07T16-13-09Z`, and `doctor` then prints `doctor ok`.

The helper starts MinIO `RELEASE.2025-09-07T16-13-09Z` with root user `minioadmin` and root password `minioadmin`. It creates bucket `verify-artifacts`. The S3 API is `http://127.0.0.1:<port>`. The console listens on a second localhost port.

This is not the container in `.github/workflows/ci.yml`. That job runs `cgr.dev/chainguard/minio:latest` and publishes port 9000 with Docker. This helper does not start Docker, does not pull that image, and does not run `docker stop`. A binary run leaves those steps unverified.

`upload/action.yml` and `download/action.yml` declare `using: node24`. The helper picks the Node binary for the bundle in this order.

1. Use `VERIFY_NODE` unchanged when it is set.
2. Use the current Node binary when its major version is 24 or higher.
3. Use the last `~/.nvm/versions/node/v24.*/bin/node` that exists.
4. Otherwise use the current Node binary.

Doctor prints `runtime-gap` whenever the selected major version is not 24.

The GitHub runner evaluates `${{ }}` defaults before the process starts. This helper does not. It sets `GITHUB_REPOSITORY` and `GITHUB_RUN_ID`. Download reads those variables when `repository` and `run-id` inputs are empty.

## Doctor

```bash
node .cursor/skills/verify-github-s3-artifact/scripts/verify.mjs doctor
```

Doctor exits 0 only when all of these are true.

- The state file exists and its MinIO pid is alive.
- `lsof` shows that pid listening on the state file's API port.
- `GET /minio/health/live` returns HTTP 200.
- `HeadBucket` succeeds for `verify-artifacts`.
- `dist/upload/index.js` and `dist/download/index.js` exist and are larger than 1000 bytes.
- The selected Node binary runs and its major version is at least 22.

Doctor prints the endpoint, Node version, MinIO pid, listener pids, GitHub run id, and the sha256 of both bundles. Run doctor before the first drive and again after any failed drive.

## Drive

Read `features/README.md`, then the feature file. Run one feature with:

```bash
node .cursor/skills/verify-github-s3-artifact/scripts/verify.mjs drive upload-archive
```

Replace `upload-archive` with the feature id. If launch left the current pointer on another live instance, pass `--state` with the `VERIFY_STATE` path from launch.

The helper sets a fresh `GITHUB_OUTPUT` file per invocation. It runs the bundle with `cwd` and `GITHUB_WORKSPACE` set to the scratch workspace. Connection variables are `S3_ARTIFACT_BUCKET=verify-artifacts`, `S3_ARTIFACT_KEY_PREFIX=verify`, `S3_ARTIFACT_ENDPOINT` from the state file, `S3_ARTIFACT_REGION=us-east-1`, and `S3_ARTIFACT_FORCE_PATH_STYLE=true`.

Drive the real bundle. Do not import `src/upload/action.ts`, call `runUpload`, or point the action at a memory store.

## Evidence

Each drive writes a directory that cleanup does not delete:

`.cursor/skills/verify-github-s3-artifact/evidence/runs/<run-id>/<feature>/`

`upload-archive` writes `summary.md`, `command.txt`, `stdout.txt`, `stderr.txt`, `exit-code.txt`, `github-output.txt`, `objects.json`, and `blob.zip`. `objects.json` has the blob head, the manifest head, and `manifestBody`. The summary records the exit code, `artifact-id`, `artifact-digest`, `artifact-url`, blob key, ETag, and size.

`upload-raw` writes the same text files and `objects.json`. It does not write `blob.zip`.

`download-by-name` writes `summary.md`, `command.txt`, `stdout.txt`, `stderr.txt`, `exit-code.txt`, and `github-output.txt`. The summary records the exit code and `download-path`.

`reject-duplicate` writes `summary.md`, `first-stdout.txt`, `first-exit-code.txt`, `second-stdout.txt`, `second-stderr.txt`, `second-exit-code.txt`, `objects.json`, and `blob.zip`. That `objects.json` contains `before`, `after`, and `manifestDigest`. The summary records both exit codes, the first `artifact-id` and `artifact-digest`, and the blob key, ETag, and size.

`no-files` writes `summary.md` plus `warn/`, `error/`, and `ignore/`. Each of those directories has `command.txt`, `stdout.txt`, `stderr.txt`, `exit-code.txt`, and `github-output.txt`. It does not write `objects.json`.

`presigned-url` writes `summary.md`, `command.txt`, `stdout.txt`, `stderr.txt`, `exit-code.txt`, `github-output.txt`, `objects.json`, and `blob.zip`. The summary records the exit code, `artifact-id`, `artifact-digest`, the URL scheme, and the downloaded sha256. It does not record the signed query string.

Capture the action result and the stored object. An exit code by itself is not proof. A zip proof reads the stored object and checks the entry bytes. A download proof reads the extracted workspace file.

## Cleanup

```bash
node .cursor/skills/verify-github-s3-artifact/scripts/verify.mjs cleanup
```

Cleanup sends `SIGTERM`, then `SIGKILL`, to the process group of the pid in the state file. It deletes that run's scratch directory, including MinIO data and the workspace. It does not delete the evidence directory. It does not signal processes by name.

Run cleanup after a failed launch or drive too, so a broken attempt does not keep the port.

## Helpers

The helper is executable.

```bash
node .cursor/skills/verify-github-s3-artifact/scripts/verify.mjs launch
node .cursor/skills/verify-github-s3-artifact/scripts/verify.mjs doctor
node .cursor/skills/verify-github-s3-artifact/scripts/verify.mjs drive <feature>
node .cursor/skills/verify-github-s3-artifact/scripts/verify.mjs cleanup
```

Optional flag for every command except launch: `--state /absolute/path/state.json`. `VERIFY_STATE` is the same override. `VERIFY_NODE` selects the Node binary that runs the bundle. `MINIO_BIN` selects an already downloaded MinIO binary. Without `MINIO_BIN`, the helper downloads the pinned release into `~/.cache/verify-github-s3-artifact/minio` and checks sha256 `7c5bd8512c6e966455b1d198209358b2d191c77a83ab377c4073281065fb855f`.

## Maintenance

When the actions change, run `/maintain-verification-skill` so the feature map stays aligned with the bundles.
