variable "bucket_arn" {
  type        = string
  description = "ARN of the artifact bucket."
}

variable "bucket_name" {
  type        = string
  description = "Name of the artifact bucket. Used only in role descriptions."
}

variable "object_prefix" {
  type        = string
  description = "Key prefix scoped to one repository: <key_prefix>/<owner>/<repo>."
}

variable "github_repository" {
  type        = string
  description = "owner/repo allowed to assume the role."
}

variable "github_repository_id" {
  type        = string
  description = "Numeric GitHub repository id."
}

variable "github_owner_id" {
  type        = string
  description = "Numeric GitHub owner id. Required for immutable subjects."
}

variable "oidc_use_immutable_subject" {
  type        = bool
  description = "Include owner and repository ids in the sub claim."
}

variable "github_environment" {
  type        = string
  description = "GitHub Environment name required in the token."
}

variable "allowed_ref" {
  type        = string
  description = "Full git ref required in the token."
}

variable "workflow_file" {
  type        = string
  description = "Accepted so existing tfvars keep applying. Not a trust condition: STS does not map workflow_ref, and job_workflow_ref is only present for reusable-workflow jobs."
}

variable "create_oidc_provider" {
  type        = bool
  description = "Create the account-wide GitHub OIDC provider."
}

variable "existing_oidc_provider_arn" {
  type        = string
  description = "Existing provider ARN when create_oidc_provider is false."
}

variable "role_name" {
  type        = string
  description = "Optional IAM role name override."
}
