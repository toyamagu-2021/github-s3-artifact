output "role_arn" {
  description = "IAM role ARN assumed by GitHub Actions."
  value       = aws_iam_role.this.arn
}

output "oidc_provider_arn" {
  description = "GitHub OIDC provider ARN."
  value       = local.oidc_provider_arn
}
