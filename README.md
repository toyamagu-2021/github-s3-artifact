# S3 Artifact GitHub Action

Drop-in replacement for `actions/upload-artifact@v7` and `actions/download-artifact@v8` backed by AWS S3 or S3-compatible object storage (Cloudflare R2, MinIO, Google Cloud Storage, Tigris, Ceph RGW, LocalStack).

Subdirectory actions only (`upload/` and `download/`), with zero temporary zip files written to disk during upload and strict Zip-Slip and SHA-256 verification during download.

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
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789012:role/github-actions-artifacts
          aws-region: us-east-1

      - run: npm ci && npm run build

      - id: up
        uses: toyamagu-2021/upload-artifact-s3/upload@v1
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
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789012:role/github-actions-artifacts
          aws-region: us-east-1

      - uses: toyamagu-2021/upload-artifact-s3/download@v1
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

## AWS OIDC Minimal IAM Policy

Attach the following policy to the IAM role assumed by `aws-actions/configure-aws-credentials`. Omit `s3:PutObjectTagging` if you manage retention purely by key prefix (the action emits a warning and proceeds if tagging is denied or unsupported).

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ListRunManifests",
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::my-org-ci-artifacts",
      "Condition": {
        "StringLike": {
          "s3:prefix": ["github-actions/*"]
        }
      }
    },
    {
      "Sid": "ReadWriteArtifacts",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:PutObjectTagging"
      ],
      "Resource": "arn:aws:s3:::my-org-ci-artifacts/github-actions/*"
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

| Output | Description |
|---|---|
| `artifact-id` | Unique 53-bit safe integer artifact ID |
| `artifact-digest` | 64-char hex SHA-256 digest (without `sha256:` prefix) |
| `artifact-url` | S3 URI (`s3://<bucket>/<blobKey>`) |

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