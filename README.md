# S3 Artifact GitHub Action

Drop-in replacement for `actions/upload-artifact@v7` and `actions/download-artifact@v8` backed by AWS S3 or S3-compatible object storage (Cloudflare R2, MinIO, Google Cloud Storage, Tigris, Ceph RGW, LocalStack).

Subdirectory actions are `upload/`, `download/`, and `merge/`. Upload writes no temporary zip on disk. Download checks Zip-Slip and SHA-256. `merge/` combines artifacts from the same run, matching `actions/upload-artifact/merge`.

## Quick Migration from GitHub Artifacts

Configure S3 connection settings once in workflow `env:`, authenticate via AWS OIDC (`aws-actions/configure-aws-credentials`), and swap the `uses:` references while keeping existing `with:` inputs intact.

```yaml
name: Build and Test
on: [push]

permissions:
  id-token: write
  contents: read

env:
  S3_ARTIFACT_BUCKET: my-org-ci-artifacts
  S3_ARTIFACT_KEY_PREFIX: github-actions

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: aws-actions/configure-aws-credentials@45666896f5d8e0f10ae255413f3a4cdd03bdc8f5 # v6.3.1
        with:
          role-to-assume: arn:aws:iam::123456789012:role/github-actions-artifacts
          aws-region: ap-northeast-1

      - run: npm ci && npm run build

      - id: up
        uses: toyamagu-2021/github-s3-artifact/upload@v0
        with:
          name: build-dist
          path: |
            dist/**
            !dist/**/*.map
          retention-days: 7

  test:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: aws-actions/configure-aws-credentials@45666896f5d8e0f10ae255413f3a4cdd03bdc8f5 # v6.3.1
        with:
          role-to-assume: arn:aws:iam::123456789012:role/github-actions-artifacts
          aws-region: ap-northeast-1

      - uses: toyamagu-2021/github-s3-artifact/download@v0
        with:
          name: build-dist
          path: ./dist
```

## Storage Layout & Concurrency Model

Artifacts are stored per repository and workflow run without a shared mutable index:

```text
s3://<bucket>/<key-prefix>/
└── <owner>/<repo>/runs/<run_id>/
    ├── blobs/
    │   └── <artifact_id>                     # .zip stream or raw file (archive: false)
    └── manifests/
        └── <url_encoded_artifact_name>.json  # metadata, sha256 digest, expiresAt, runAttempt
```

- **Crash safety**: Blob streams are uploaded first; the manifest JSON is written last with conditional `If-None-Match: *` (`overwrite: false`, same `runAttempt`) or `If-Match: <etag>` (`overwrite: true` or re-run with higher `runAttempt`). Incomplete uploads never surface to `download`.
- **Re-run failed jobs**: Attempt 2 can re-upload its own artifact with `overwrite: false` while attempt 1 artifacts remain readable under the same `<run_id>`.

## Using with AWS

Apply [`examples/terraform`](examples/terraform/README.md) in the account that will store artifacts. The sample creates the bucket and the OIDC role. It does not run from GitHub Actions: the first apply uses credentials you already have, because the role does not exist yet.

The example region is `ap-northeast-1`. `aws_region` has no default in the module. Encryption is SSE-S3 (`AES256`), not KMS. A monthly cost budget is optional and off by default; the runbook recommends `$5` once the stack is up. A required reviewer on the GitHub Environment is optional and, on a solo account, only confirms the dispatch.

Pin `aws-actions/configure-aws-credentials` to a commit. The role session must be at least as long as `presign-expires-seconds`. A presigned URL dies when the session dies. Repositories created after 15 July 2026, including this one, use immutable OIDC subjects (`repo:OWNER@OWNER_ID/REPO@REPO_ID:...`). Read `sub_claim_prefix` from the repository OIDC customization API before writing the trust policy.

Do not add a bucket policy that requires the `s3:x-amz-server-side-encryption` request header. This action does not send one. Bucket default encryption still applies.

## AWS OIDC Minimal IAM Policy

Attach the following policy to the IAM role assumed by `aws-actions/configure-aws-credentials`. It is the policy `examples/terraform` creates. Scope the ARNs to `<key-prefix>/<owner>/<repo>/`, not the whole bucket. Blob upload uses multipart, so `s3:PutObject` covers `CreateMultipartUpload`, `UploadPart`, and `CompleteMultipartUpload`, and `s3:AbortMultipartUpload` covers the failure path (`leavePartsOnError: false`).

`s3:PutObject` is allowed only when the object has no tags or the only tag key is `s3-artifact-retention-days`. An unconditional `s3:PutObject` statement would bypass that limit. Omit `s3:PutObjectTagging` only if you accept the action's warning and a retry without the retention tag.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ListRepoManifests",
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::my-org-ci-artifacts",
      "Condition": {
        "StringLike": {
          "s3:prefix": ["github-actions/my-org/my-repo/*"]
        }
      }
    },
    {
      "Sid": "ReadDeleteAndAbort",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:DeleteObject",
        "s3:AbortMultipartUpload"
      ],
      "Resource": "arn:aws:s3:::my-org-ci-artifacts/github-actions/my-org/my-repo/*"
    },
    {
      "Sid": "WriteWithRetentionTagOnly",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:PutObjectTagging"],
      "Resource": "arn:aws:s3:::my-org-ci-artifacts/github-actions/my-org/my-repo/*",
      "Condition": {
        "ForAllValues:StringEquals": {
          "s3:RequestObjectTagKeys": ["s3-artifact-retention-days"]
        }
      }
    }
  ]
}
```

## S3-Compatible Provider Examples

### Cloudflare R2

R2 does not support S3 object tagging; `retention-days` still records `expiresAt` in the manifest (so expired artifacts are hidden from `download`) and falls back with a warning when tagging returns `NotImplemented`. Configure R2 bucket lifecycle rules on the prefix for physical deletion.

```yaml
env:
  S3_ARTIFACT_BUCKET: ci-artifacts
  S3_ARTIFACT_ENDPOINT: https://<ACCOUNT_ID>.r2.cloudflarestorage.com
  S3_ARTIFACT_REGION: auto
  AWS_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
  AWS_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
```

### MinIO / LocalStack

```yaml
env:
  S3_ARTIFACT_BUCKET: ci-artifacts
  S3_ARTIFACT_ENDPOINT: http://127.0.0.1:9000
  S3_ARTIFACT_REGION: us-east-1
  S3_ARTIFACT_FORCE_PATH_STYLE: 'true'
  AWS_ACCESS_KEY_ID: ${{ secrets.MINIO_ACCESS_KEY }}
  AWS_SECRET_ACCESS_KEY: ${{ secrets.MINIO_SECRET_KEY }}
```

## S3 Lifecycle Retention Rules

When `retention-days` is set (for example `retention-days: 7`), both blob and manifest objects are tagged with `s3-artifact-retention-days=<N>` and `expiresAt` is enforced at read time. Match object tags (or a fallback prefix rule for untagged runs) in your S3 Lifecycle configuration:

```json
{
  "Rules": [
    {
      "ID": "expire-7d-artifacts",
      "Status": "Enabled",
      "Filter": {
        "And": {
          "Prefix": "github-actions/",
          "Tags": [
            { "Key": "s3-artifact-retention-days", "Value": "7" }
          ]
        }
      },
      "Expiration": { "Days": 7 }
    },
    {
      "ID": "abort-incomplete-multipart-uploads",
      "Status": "Enabled",
      "Filter": { "Prefix": "github-actions/" },
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 1 }
    }
  ]
}
```

## Inputs & Outputs Reference

### Upload (`upload/action.yml`)

| Input | Default | Description |
|---|---|---|
| `name` | `'artifact'` | Artifact name (ignored when `archive: false`; file basename is used instead) |
| `path` | *(required)* | File, directory, multiline glob patterns, and `!` exclusions |
| `if-no-files-found` | `'warn'` | Behavior when zero files match: `warn`, `error`, or `ignore` |
| `retention-days` | *(unset)* | Retention days (`expiresAt` in manifest + `s3-artifact-retention-days` tag); capped by `GITHUB_RETENTION_DAYS` |
| `compression-level` | `'6'` | Zlib level `0`–`9` |
| `overwrite` | `'false'` | Replace existing artifact with matching name |
| `include-hidden-files` | `'false'` | Include dotfiles and dot-directories |
| `archive` | `'true'` | Zip files when `true`; upload a single raw file when `false` |
| `bucket` | `$S3_ARTIFACT_BUCKET` | Target S3 bucket (required via input or env) |
| `key-prefix` | `$S3_ARTIFACT_KEY_PREFIX` | Optional object key prefix |
| `region` | `$S3_ARTIFACT_REGION`, `$AWS_REGION`, `$AWS_DEFAULT_REGION` | S3 region (`auto` when `endpoint` is set, otherwise `us-east-1`) |
| `endpoint` | `$S3_ARTIFACT_ENDPOINT`, `$AWS_ENDPOINT_URL_S3`, `$AWS_ENDPOINT_URL` | Custom S3 endpoint URL |
| `force-path-style` | `$S3_ARTIFACT_FORCE_PATH_STYLE` (`'false'`) | Force path-style S3 URLs |
| `access-key-id` | *(AWS env / OIDC)* | Explicit AWS access key ID |
| `secret-access-key` | *(AWS env / OIDC)* | Explicit AWS secret access key (masked in logs) |
| `session-token` | *(AWS env / OIDC)* | Explicit AWS session token (masked in logs) |
| `artifact-url-format` | `$S3_ARTIFACT_URL_FORMAT` (`'s3'`) | `s3` emits `s3://<bucket>/<blobKey>`; `presigned` emits a signed `GetObject` URL |
| `presign-expires-seconds` | `$S3_ARTIFACT_PRESIGN_EXPIRES_SECONDS` (`'3600'`) | Lifetime of a presigned `artifact-url` in seconds (`1`–`604800`) |

| Output | Description |
|---|---|
| `artifact-id` | Unique 53-bit safe integer artifact ID |
| `artifact-digest` | 64-char hex SHA-256 digest (without `sha256:` prefix) |
| `artifact-url` | S3 URI (`s3://<bucket>/<blobKey>`) by default, or a presigned `GetObject` URL when `artifact-url-format` is `presigned` |

### Download (`download/action.yml`)

| Input | Default | Description |
|---|---|---|
| `name` | *(unset)* | Artifact name to download; omit to match all artifacts in scope |
| `artifact-ids` | *(unset)* | Comma-separated numeric artifact IDs (mutually exclusive with `name`) |
| `path` | `$GITHUB_WORKSPACE` | Destination directory (supports `~` expansion) |
| `pattern` | *(unset)* | Minimatch glob pattern filtering artifact names when `name` is omitted |
| `merge-multiple` | `'false'` | Extract all matched artifacts into `path` (`true`) or `<path>/<name>` (`false`; 1 match still extracts directly) |
| `github-token` | *(unset)* | Accepted for workflow drop-in compatibility; ignored by S3 backend |
| `repository` | `${{ github.repository }}` | Source `owner/repo` scope |
| `run-id` | `${{ github.run_id }}` | Source workflow run ID |
| `skip-decompress` | `'false'` | Write downloaded `.zip` (or raw file) without extracting |
| `digest-mismatch` | `'error'` | SHA-256 verification mismatch handling: `error`, `warn`, `info`, `ignore` |
| `bucket`, `key-prefix`, `region`, `endpoint`, `force-path-style`, `access-key-id`, `secret-access-key`, `session-token` | *(same env fallbacks as `upload`)* | S3 connection overrides |

| Output | Description |
|---|---|
| `download-path` | Resolved absolute destination directory path |

### Merge (`merge/action.yml`)

| Input | Default | Description |
|---|---|---|
| `name` | `'merged-artifacts'` | Name of the consolidated artifact |
| `pattern` | `'*'` | Minimatch glob pattern matching artifact names in the current workflow run |
| `separate-directories` | `'false'` | Extract each matched artifact into `<name>/` before re-archiving (`true`) or combine at archive root (`false`) |
| `retention-days` | *(unset)* | Retention days for the merged artifact; capped by `GITHUB_RETENTION_DAYS` |
| `compression-level` | `'6'` | Zlib level `0`–`9` |
| `delete-merged` | `'false'` | Delete source manifests first and blobs best-effort after the merged artifact commits |
| `include-hidden-files` | `'false'` | Include dotfiles and dot-directories in the merged archive |
| `artifact-url-format`, `presign-expires-seconds` | *(same env fallbacks as `upload`)* | Presigned `artifact-url` controls |
| `bucket`, `key-prefix`, `region`, `endpoint`, `force-path-style`, `access-key-id`, `secret-access-key`, `session-token` | *(same env fallbacks as `upload`)* | S3 connection overrides |

| Output | Description |
|---|---|
| `artifact-id` | Unique 53-bit safe integer artifact ID for the merged artifact |
| `artifact-digest` | 64-char hex SHA-256 digest (without `sha256:` prefix) |
| `artifact-url` | S3 URI (`s3://<bucket>/<blobKey>`) by default, or a presigned `GetObject` URL when `artifact-url-format` is `presigned` |

## Runtime Tuning Environment Variables

Compatible with `@actions/artifact` transfer tuning variables:

| Environment Variable | Default | Behavior |
|---|---|---|
| `ACTIONS_ARTIFACT_UPLOAD_CONCURRENCY` | `5` | Multipart S3 upload queue concurrency (capped at `32` for `<=4` CPUs, otherwise `min(16 * cpus, 300)`) |
| `ACTIONS_ARTIFACT_UPLOAD_TIMEOUT_MS` | `300000` | Aborts an upload when progress stalls for this duration in milliseconds |
| `ACTIONS_ARTIFACT_MAX_ARTIFACT_COUNT` | `1000` | Maximum non-expired artifacts returned by multi-artifact `download` and `merge` listings (emits a warning when truncated) |

Blob downloads automatically retry transient stream failures up to 5 attempts with a 5-second backoff and a 30-second per-chunk inactivity timeout.