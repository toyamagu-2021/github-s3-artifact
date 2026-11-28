---
name: verify-upload-commit
description: "Formally check the S3 upload commit protocol (blob first, then a conditional manifest) for github-s3-artifact. Use when changing run-upload.ts, s3-store.ts, memory-store.ts, run-download.ts, store.ts types WriteGuard, or this skill; after overwrite, re-run, crash-safety, or duplicate-name work; or for /verify-upload-commit."
---

# Verify upload commit

Two matrix jobs in the same run can both call `runUpload` for one artifact name. The live object a later `runDownload` sees must be one fully committed blob, never a partial upload, and never two `overwrite: false` winners in the same `GITHUB_RUN_ATTEMPT`.

Harm: a job that thought it published uniquely is overwritten, or `download` extracts a blob that has no committed manifest.

## When to run

Run this check before you finish any change that touches the files in **Covered code**. Skip it only when the diff cannot change those functions.

## Covered code

Last confirmed at commit `8e65ed21ae6f6dbae46b428eb54fa6d1d2182541`. Move that hash forward only after you confirm the TLA+ actions still match the code at the new commit.

| Code | What the model treats as one step |
|---|---|
| `src/upload/run-upload.ts` `runUpload` | `GetManifestWithMeta`, guard choice, `PutBlobStream`, `CommitManifest`, `DeleteOwnBlobBestEffort`, `DeleteOldBlobBestEffort` |
| `src/storage/s3-store.ts` `commitManifest` / `putBlobStream` / `deleteBlobBestEffort` | `If-None-Match: *`, `If-Match: <etag>`, blob PUT, best-effort DELETE |
| `src/storage/memory-store.ts` `commitManifest` | the same `WriteGuard` checks |
| `src/download/run-download.ts` `runDownload` (named path) | read `getManifestWithMeta`; missing or expired is not-found; else open `manifest.blobKey` |
| `src/shared/types.ts` `WriteGuard`, `ArtifactManifestV1.runAttempt` | guard modes and re-run comparison |

## Command

From the repo root, Linux / macOS / WSL, Python 3.10+ and either Java 11+ or Docker:

```sh
python3 .grok/skills/verify-upload-commit/scripts/check.py
```

The script pins TLC `1.7.4` (`tla2tools.jar` sha256 `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`) and, when `java` is missing, Docker image `eclipse-temurin:21-jre` at digest `sha256:d77e090ae1f6970c047b443c6f0a6c1358b0426d44432bb5a7753408cd43de0d`. It checks that the code still contains the protocol steps, then model-checks three configs:

- `UploadCommit.cfg` — two `overwrite: false` jobs, empty run, attempt 1 (AC-06 parallel)
- `UploadCommitOverwrite.cfg` — two `overwrite: true` jobs replacing a live artifact (CAS)
- `UploadCommitRerun.cfg` — two attempt-2 jobs with `overwrite: false` replacing attempt 1 (AC-08)

It must print `PASS` and exit 0. A run is a few seconds after TLC and Java are cached under `.grok/skills/verify-upload-commit/.tool-cache/`.

## Read the result

Read every TLA+ result with `/statechart`. Point it at `.grok/skills/verify-upload-commit/model/UploadCommit.tla` and `.grok/skills/verify-upload-commit/model/view.mjs`. Use `/statechart` for a pass (the chart of how jobs move) and for a fail (the shortest path that breaks a rule).

## Tell a real bug from a modeling error

- **Correspondence FAIL** — the code no longer contains the steps the model names, in that order. If the change was accidental, restore the protocol. If it was intended, edit the TLA+ actions so each step is still one await / one S3 call in the new code, then rerun. Do not move the sync commit until TLC passes on that new description.
- **TLC invariant FAIL** — replay the counterexample as `runUpload` / `commitManifest` calls. If every step can happen in the code, it is a bug: report it in the code's words and do not weaken the invariant. If a step cannot happen, the model is wrong: fix the model.
- **PASS** — the properties hold for two jobs, one name, one run, attempts `{1,2}`, under the assumptions below. It is not a proof of S3, multipart, or the whole action.

Properties, in the code's words:

1. `CommittedBlobExists` — a committed `manifests/<name>.json` always names a blob that still exists, so named `runDownload` cannot open a missing blob.
2. `SameAttemptExclusive` — at most one `overwrite: false` job in the same `runAttempt` reaches a successful `commitManifest`.
3. `DoneIsCurrentOrReplacedBySnapshot` — a job that published stays the live artifact unless another job replaced it with the etag it actually read.

## Confirm the check can fail

Do not ship a check you have never seen fail. After an intended protocol edit, or when you first touch this skill:

1. In `src/storage/s3-store.ts` `commitManifest`, delete `baseInput.IfNoneMatch = '*'`. Run the command. It must FAIL correspondence. Restore the line.
2. In `model/UploadCommit.tla` `CommitManifest`, make the `create-only` branch write the manifest even when `hasManifest` is TRUE. Run the command. TLC must violate `SameAttemptExclusive`. The path is: both jobs `getManifestWithMeta` while empty, both `putBlobStream`, both `commitManifest` succeed. Restore the action.

Drop every scratch change before you commit product or skill files.

## After an intended change

1. Diff the covered files against the sync commit. If a step split, merged, or moved, edit the matching TLA+ action so one model step is still one code step.
2. Run the command. If TLC fails and the trace is possible in the code, that is a bug — stop and report it.
3. Show the check can still fail (the two scratches above, then drop them).
4. Only then set the sync commit in this file to `git rev-parse HEAD`.

For merges and edits that skipped this skill, use `/maintain-formal-verification-skill`.

## Bounds and assumptions

Verified: two jobs, one artifact name, one `run_id`, `overwrite` and `runAttempt` as in the three configs, fail-stop crash only after `putBlobStream` and before `commitManifest`. Conditional writes behave like AWS S3 and `InMemoryArtifactStore` (atomic `If-None-Match` / `If-Match`).

Not covered:

- S3 endpoints that return 501 for conditionals: `putManifestWithFallbacks` then retries with an unconditional PUT (`s3-store.ts`). Concurrent `overwrite: false` can lose exclusivity there.
- `WriteGuard` mode `unconditional` when `getManifestWithMeta` returns no etag.
- Expired manifests (`isManifestExpired` / `existing.expired`).
- `deleteArtifact` vs a concurrent `runUpload` of the same name (`s3-store.ts` `deleteArtifact` snapshots the blob, deletes the manifest key, then deletes the snapshot). Merge `delete-merged` uses this.
- Multipart part lists, tagging, presign, glob, zip, digest mismatch, `listManifests` caps.
- More than two jobs or more than one name.
