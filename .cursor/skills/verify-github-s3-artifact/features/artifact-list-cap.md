# Artifact list cap

Artifact list cap stops a download of every artifact in the run after `ACTIONS_ARTIFACT_MAX_ARTIFACT_COUNT` manifests.

## Sub-features

- `cap-one` extracts the first artifact directly and leaves the second manifest in S3.

## How to get to it (user POV)

- Upload `side-a` and `side-b` in one run, then download with no `name` and `ACTIONS_ARTIFACT_MAX_ARTIFACT_COUNT=1`.
- From this checkout, `uses: ./download` runs `dist/download/index.js`.

## Driving it with verify-github-s3-artifact

Preconditions:

- Doctor prints `doctor ok` for this state.
- This state has no manifests named `side-a` or `side-b`.

- **Place the files.** Write `cap/a.txt` as `alpha` plus a newline and `cap/b.txt` as `beta` plus a newline. The helper does this.
- **Upload both.** The helper runs `dist/upload/index.js` for `side-a` and `side-b`. Both exit `0`.
- **Download with the cap.** Run `node .cursor/skills/verify-github-s3-artifact/scripts/verify.mjs drive artifact-list-cap`. The download bundle gets `ACTIONS_ARTIFACT_MAX_ARTIFACT_COUNT=1` and `INPUT_PATH=out-cap`. Exit code is `0`.
- **Read the workspace.** One listed artifact extracts directly, so `out-cap/a.txt` is `alpha` plus a newline. `out-cap/side-b` does not exist. The `side-b` manifest is still in the bucket.
- **Read the warning.** Stdout contains `limit of 1`.

## Gotchas

- The cap follows manifest key order. `side-a` sorts before `side-b`.
- The second object stays in the bucket. The cap limits the list, it does not delete.
- The default cap is 1000. This drive sets `1` only on the download process.
