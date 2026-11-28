# AWS sample stack

Reusable Terraform for one artifact bucket and one GitHub OIDC role. The bucket uses SSE-S3, blocks public access, enforces bucket-owner ownership, and denies non-TLS requests. The role can call only the S3 APIs this action uses, and only under `<key_prefix>/<owner>/<repo>/`.

This directory has no remote backend block. `terraform init -backend=false` is what CI runs. Apply it yourself with your own AWS credentials. GitHub Actions does not apply this stack, because there is no bootstrap role yet.

`aws_region` has no default. `terraform.tfvars.example` sets `ap-northeast-1` (Tokyo).

## What you get

| Module | Owns |
|---|---|
| `modules/artifact_bucket` | Bucket, public access block, `BucketOwnerEnforced`, SSE-S3 (`AES256`), TLS-only bucket policy, lifecycle |
| `modules/github_oidc_role` | GitHub OIDC provider (only if you ask) and the IAM role |
| root | Wires one `key_prefix` and one repository into both modules. Optional monthly budget, off by default |

Lifecycle on `<key_prefix>/<owner>/<repo>/`:

- Abort incomplete multipart uploads after 1 day.
- Expire every object after `expiration_days` (default 14), including blobs whose manifest never landed.
- Expire objects tagged `s3-artifact-retention-days=N` after N days for each N in `retention_tag_days` (default `7`, which matches the e2e `retention-days`).
- Versioning stays off unless `enable_versioning` is true. The action's `If-Match` writes do not need it.

SSE-KMS is not part of this sample. The action never sends an SSE header or a KMS key id. Do not add a bucket policy that denies uploads missing `s3:x-amz-server-side-encryption`; bucket default encryption still encrypts the object, and that deny would break the action.

## Apply runbook

Use an AWS principal that can create S3 buckets and IAM roles (and the GitHub OIDC provider, if it does not exist yet). The artifact role you are about to create cannot do this.

### 1. Create the state bucket

Pick a globally unique name. This bucket stores Terraform state only.

```bash
export AWS_REGION=ap-northeast-1
export STATE_BUCKET=REPLACE-ME-tfstate

aws s3api create-bucket \
  --bucket "$STATE_BUCKET" \
  --region ap-northeast-1 \
  --create-bucket-configuration LocationConstraint=ap-northeast-1

aws s3api put-public-access-block \
  --bucket "$STATE_BUCKET" \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

aws s3api put-bucket-versioning \
  --bucket "$STATE_BUCKET" \
  --versioning-configuration Status=Enabled

aws s3api put-bucket-encryption \
  --bucket "$STATE_BUCKET" \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'

aws s3api put-bucket-ownership-controls \
  --bucket "$STATE_BUCKET" \
  --ownership-controls '{"Rules":[{"ObjectOwnership":"BucketOwnerEnforced"}]}'
```

`ap-northeast-1` is not `us-east-1`, so `create-bucket` needs `LocationConstraint`. Skip the state bucket only if you accept local state on one machine. Do not commit `terraform.tfstate`.

### 2. Check for an existing GitHub OIDC provider

An account can hold only one provider for `token.actions.githubusercontent.com`.

```bash
aws iam list-open-id-connect-providers \
  --query "OpenIDConnectProviderList[?contains(Arn, 'token.actions.githubusercontent.com')].Arn" \
  --output text
```

- Empty: in `terraform.tfvars`, set `create_oidc_provider = true` and `existing_oidc_provider_arn = ""`.
- An ARN: set `create_oidc_provider = false` and paste that ARN into `existing_oidc_provider_arn`.

### 3. Configure and apply

```bash
cd examples/terraform
cp terraform.tfvars.example terraform.tfvars
cp backend.s3.hcl.example backend.s3.hcl
```

Edit `terraform.tfvars`:

- `aws_region`: `ap-northeast-1` unless you change the state bucket region too.
- `bucket_name`: a globally unique artifact bucket name. This bucket is for CI fixtures, not private release artifacts. Presigned URLs of objects in it show up in public Actions logs.
- `github_repository`, `github_repository_id`, and `github_owner_id`: the example already has this repo's public ids (`toyamagu-2021/github-s3-artifact`, `1472027889`, `83329336`). This repo uses immutable OIDC subjects (`use_immutable_subject: true`). Confirm with:

  ```bash
  gh api repos/toyamagu-2021/github-s3-artifact/actions/oidc/customization/sub
  ```

  `sub_claim_prefix` must be `repo:toyamagu-2021@83329336/github-s3-artifact@1472027889`.

- Leave `enable_budget` false for the first apply. A later apply with `enable_budget = true`, `budget_usd = 5`, and a real `budget_email` adds actual and forecast alarms at 80% and 100%. The budget resource is created in `us-east-1` because that is the Budgets API region. It needs billing permissions.

Edit `backend.s3.hcl` so `bucket` is `$STATE_BUCKET` and `region` is `ap-northeast-1`.

```bash
terraform init -backend-config=backend.s3.hcl
terraform plan
terraform apply
```

`force_destroy` stays false. Set it true only in your uncommitted tfvars if this bucket will hold nothing you need to keep and you want `terraform destroy` to empty it.

### 4. Copy outputs into GitHub

```bash
terraform output github_actions_variables
```

`S3_ARTIFACT_KEY_PREFIX` is `github-actions`, not `github-actions/owner/repo`. The action adds `<owner>/<repo>/runs/<run_id>/` itself. The IAM policy allows only that repository prefix.

Create GitHub Environment `aws-e2e` with deployment branch `main` only. Required reviewers are optional. On a solo account the person who dispatches the workflow is also the reviewer, so this is a confirmation prompt, not a second person. Each job in `.github/workflows/aws-e2e.yml` that sets `environment: aws-e2e` waits for that approval. Add a reviewer later in the environment's settings if you want the prompt. Do not add one in this command.

```bash
gh api --method PUT repos/toyamagu-2021/github-s3-artifact/environments/aws-e2e \
  --input - <<'EOF'
{
  "deployment_branch_policy": {
    "protected_branches": false,
    "custom_branch_policies": true
  }
}
EOF

gh api --method POST \
  repos/toyamagu-2021/github-s3-artifact/environments/aws-e2e/deployment-branch-policies \
  -f name=main

gh variable set AWS_ROLE_ARN --env aws-e2e --body "arn:aws:iam::ACCOUNT:role/ROLE"
gh variable set AWS_REGION --env aws-e2e --body "ap-northeast-1"
gh variable set S3_ARTIFACT_BUCKET --env aws-e2e --body "BUCKET"
gh variable set S3_ARTIFACT_KEY_PREFIX --env aws-e2e --body "github-actions"
```

Those four names are environment variables, not secrets.

Opt in the workflow with a repository variable (not an environment variable; the job `if` reads it before the environment is selected):

```bash
gh variable set AWS_E2E_ENABLED --body "true"
```

Leave `aws-e2e` off the branch ruleset. The required checks stay `verify`, `minio-docker-integration`, and `actions-e2e`. Fork pull requests cannot obtain an OIDC token, so a required AWS check would block them.

Dispatch **AWS e2e** once from `main` after `.github/workflows/aws-e2e.yml` is on `main` and this stack has been applied. The `push` trigger in that file stays commented. Uncomment it only after a dispatch succeeds. A later push to `main` can assume the role without another apply, because the trust policy does not filter `event_name`.

## Trust policy

STS maps these GitHub claims to condition keys: `actor`, `actor_id`, `job_workflow_ref`, `repository`, `repository_id`, `repository_owner_id`, `workflow`, `ref`, `environment`, `enterprise_id`, plus `aud` and `sub`. It does not map `workflow_ref` or `event_name`. A `StringEquals` on an unmapped key never matches, so the role cannot be assumed. `job_workflow_ref` is mapped, but [GitHub's OIDC docs](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-with-reusable-workflows) include that claim only when the job is part of a reusable workflow. The jobs in `aws-e2e.yml` are inline, so the sample does not condition on it.

The role assumes only when all of these match:

- `aud` is `sts.amazonaws.com`
- `repository` is `toyamagu-2021/github-s3-artifact` and `repository_id` is `1472027889`
- `repository_owner_id` is `83329336` when `github_owner_id` is set (it is in the example tfvars)
- `ref` is `refs/heads/main`
- `environment` is `aws-e2e`
- `sub` is `repo:toyamagu-2021@83329336/github-s3-artifact@1472027889:environment:aws-e2e`

A pull request still cannot assume the role. Its `ref` is `refs/pull/<n>/merge`, not `refs/heads/main`. `sub` requires `:environment:aws-e2e`, and the GitHub Environment deployment branch policy allows only `main`. The workflow file has no `pull_request` trigger. After any change to this policy, run `terraform apply` before dispatching again.

## Identity policy

`s3:ListBucket` on the bucket, only for prefix `<key_prefix>/<owner>/<repo>/*`.

`s3:GetObject`, `s3:DeleteObject`, and `s3:AbortMultipartUpload` on that prefix. Blob uploads go through multipart (`CreateMultipartUpload`, `UploadPart`, `CompleteMultipartUpload` are `s3:PutObject`). Failures call `AbortMultipartUpload`.

`s3:PutObject` and `s3:PutObjectTagging` on that prefix, only when the request has no tag or the only tag key is `s3-artifact-retention-days`. `PutObject` is not granted by a second statement without that condition.

Presigned URLs are a local signature over `GetObject`. They stop working when `presign-expires-seconds` elapses or the STS session ends, whichever is sooner. The e2e workflow asks for a 900 second session and a 300 second URL.
