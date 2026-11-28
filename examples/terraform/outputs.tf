output "bucket_name" {
  description = "Artifact bucket name. Copy to the GitHub Environment variable S3_ARTIFACT_BUCKET."
  value       = module.artifact_bucket.bucket_name
}

output "bucket_arn" {
  description = "Artifact bucket ARN."
  value       = module.artifact_bucket.bucket_arn
}

output "role_arn" {
  description = "IAM role ARN. Copy to the GitHub Environment variable AWS_ROLE_ARN."
  value       = module.github_oidc_role.role_arn
}

output "oidc_provider_arn" {
  description = "GitHub OIDC provider ARN used by the role trust policy."
  value       = module.github_oidc_role.oidc_provider_arn
}

output "github_actions_variables" {
  description = "Values for GitHub Environment aws-e2e. S3_ARTIFACT_KEY_PREFIX is the prefix only; the action appends owner/repo/runs/<run_id>."
  value = {
    AWS_ROLE_ARN           = module.github_oidc_role.role_arn
    AWS_REGION             = var.aws_region
    S3_ARTIFACT_BUCKET     = module.artifact_bucket.bucket_name
    S3_ARTIFACT_KEY_PREFIX = var.key_prefix
  }
}
