# github-s3-artifact verification map

This directory is the maintained source for the user-facing upload and download actions. Read this index, then use the matching feature file.

## Baseline preconditions

- The checkout is `toyamagu-2021/github-s3-artifact`.
- `npm ci` and `npm run build` have been run from the repo root.
- `node .cursor/skills/verify-github-s3-artifact/scripts/verify.mjs launch` has printed `VERIFY_STATE`.
- `doctor` prints `doctor ok` for that state.
- The published workflow references are `uses: toyamagu-2021/github-s3-artifact/upload@v0` and `uses: toyamagu-2021/github-s3-artifact/download@v0`. Local drives run the bundles those actions point at.
- Drive only the instance this verification run started.

## Driving conventions

- Start every recipe from the baseline state unless its preconditions say otherwise.
- Treat every command as literal.
- Pass `--state` when the current pointer belongs to another live instance.
- The helper writes `GITHUB_OUTPUT` itself. Do not reuse an output file across drives.
- A second `upload-archive` on the same state conflicts with `build-dist`. Launch again for a fresh run id.
- Restore nothing in the MinIO bucket during the recipe. Cleanup deletes that MinIO data directory. Leave proof files in `evidence/runs/`.

## Proof and skip reporting

- Record the feature id, exit code, action outputs, and the S3 key, ETag, and size when the feature stores an object.
- Read the stored object or the extracted file. Do not stop at the action log.
- Report an unreachable path with the command you ran and the unmet precondition.
- Do not mark a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file has an H1, one paragraph, and these H2 sections in order.

1. `Sub-features`
2. `How to get to it (user POV)`
3. `Driving it with verify-github-s3-artifact`
4. `Gotchas`

## Features

- [Upload an archived artifact](./upload-archive.md) stores one file in a zip and checks the step outputs plus the blob and manifest.
- [Upload a raw file](./upload-raw.md) stores one file without a zip and uses the basename as the artifact name.
- [Download by name](./download-by-name.md) extracts one named artifact into the destination directory.
- [Reject a duplicate name](./reject-duplicate.md) keeps the first object when a second upload does not set overwrite.
- [No matching files](./no-files.md) covers warn, error, and ignore when the path matches nothing.
- [Artifact list cap](./artifact-list-cap.md) returns only the first N artifacts when `ACTIONS_ARTIFACT_MAX_ARTIFACT_COUNT` is set.
- [Presigned artifact URL](./presigned-url.md) returns a signed GetObject URL and the bytes at that URL match the stored zip.

## Not in this map

These user-facing paths are not recipes yet.

- `overwrite: true`
- A later `GITHUB_RUN_ATTEMPT` that replaces one artifact and leaves another
- `retention-days`, `expiresAt`, and the `s3-artifact-retention-days` tag
- Hidden files, symlinks, and multi-path globs with `!` exclusions
- `compression-level`
- Download by `artifact-ids`, `pattern`, `merge-multiple`, or `skip-decompress`
- `digest-mismatch`
- A zip-slip archive
- Download from another `repository` or `run-id`
- Credential inputs and secret masking
