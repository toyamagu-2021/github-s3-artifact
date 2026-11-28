variable "aws_region" {
  type        = string
  description = "Region for the artifact bucket and the default AWS provider. No default: set it in tfvars (this repo's example uses ap-northeast-1)."

  validation {
    condition     = can(regex("^[a-z]{2}-[a-z]+-[0-9]+$", var.aws_region))
    error_message = "aws_region must be an AWS region code such as ap-northeast-1."
  }
}

variable "bucket_name" {
  type        = string
  description = "Globally unique name for the artifact bucket."

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.bucket_name)) && !strcontains(var.bucket_name, "..")
    error_message = "bucket_name must be a valid S3 bucket name."
  }
}

variable "key_prefix" {
  type        = string
  description = "S3_ARTIFACT_KEY_PREFIX. The action appends <owner>/<repo>/runs/<run_id>/ under this prefix."
  default     = "github-actions"

  validation {
    condition     = length(var.key_prefix) > 0 && !startswith(var.key_prefix, "/") && !endswith(var.key_prefix, "/") && !strcontains(var.key_prefix, "..")
    error_message = "key_prefix must be non-empty and must not start or end with a slash."
  }
}

variable "github_repository" {
  type        = string
  description = "GitHub repository that may assume the role, as owner/repo. Also the S3 key scope."

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repository))
    error_message = "github_repository must be owner/repo."
  }
}

variable "github_repository_id" {
  type        = string
  description = "Numeric GitHub repository id (repository_id claim). This repo is 1472027889."

  validation {
    condition     = can(regex("^[0-9]+$", var.github_repository_id))
    error_message = "github_repository_id must be the numeric repository id."
  }
}

variable "github_owner_id" {
  type        = string
  description = "Numeric GitHub user or org id. Required when oidc_use_immutable_subject is true. This account is 83329336."
  default     = ""
}

variable "oidc_use_immutable_subject" {
  type        = bool
  description = "True when the repo's OIDC sub includes owner and repository ids (repos created after 2026-07-15, including this one)."
  default     = true
}

variable "github_environment" {
  type        = string
  description = "GitHub Environment the workflow job must select. Becomes the OIDC sub suffix."
  default     = "aws-e2e"

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]{1,64}$", var.github_environment))
    error_message = "github_environment must be 1-64 characters of letters, digits, dot, underscore, or hyphen."
  }
}

variable "allowed_ref" {
  type        = string
  description = "Git ref claim required to assume the role."
  default     = "refs/heads/main"

  validation {
    condition     = startswith(var.allowed_ref, "refs/")
    error_message = "allowed_ref must be a full git ref such as refs/heads/main."
  }
}

variable "extra_allowed_refs" {
  type        = list(string)
  description = "Additional exact refs that may assume the role. Use the release-please branch so its push can run AWS e2e. pull_request refs (refs/pull/<n>/merge) do not match."
  default     = []

  validation {
    condition     = alltrue([for ref in var.extra_allowed_refs : startswith(ref, "refs/")])
    error_message = "each extra_allowed_refs entry must be a full git ref."
  }
}

variable "workflow_file" {
  type        = string
  description = "Kept so existing tfvars files still apply. Not sent to AWS. STS does not map workflow_ref, and GitHub puts job_workflow_ref only on reusable-workflow jobs."
  default     = ".github/workflows/aws-e2e.yml"

  validation {
    condition     = startswith(var.workflow_file, ".github/workflows/") && endswith(var.workflow_file, ".yml")
    error_message = "workflow_file must be .github/workflows/*.yml."
  }
}

variable "create_oidc_provider" {
  type        = bool
  description = "Create the account-wide GitHub OIDC provider. Leave false when token.actions.githubusercontent.com already exists."
  default     = false
}

variable "existing_oidc_provider_arn" {
  type        = string
  description = "ARN of the existing GitHub OIDC provider. Required when create_oidc_provider is false."
  default     = ""
}

variable "expiration_days" {
  type        = number
  description = "Prefix-wide lifecycle cap, in days, for this repository's keys."
  default     = 14

  validation {
    condition     = var.expiration_days >= 1 && var.expiration_days <= 3650
    error_message = "expiration_days must be between 1 and 3650."
  }
}

variable "retention_tag_days" {
  type        = list(number)
  description = "Expire objects tagged s3-artifact-retention-days=N after N days. Each N must be <= expiration_days."
  default     = [7]

  validation {
    condition = length(var.retention_tag_days) == length(distinct(var.retention_tag_days)) && alltrue([
      for days in var.retention_tag_days : days == floor(days) && days >= 1
    ])
    error_message = "retention_tag_days must be unique whole numbers >= 1."
  }
}

variable "enable_versioning" {
  type        = bool
  description = "Enable bucket versioning. Leave false for CI artifacts; overwrite then keeps every old object until a noncurrent expiration."
  default     = false
}

variable "force_destroy" {
  type        = bool
  description = "Allow terraform destroy to delete remaining objects. Leave false unless this bucket holds only disposable e2e data."
  default     = false
}

variable "enable_budget" {
  type        = bool
  description = "Create a monthly cost budget and email alarms. Off until billing permissions and an email are available."
  default     = false
}

variable "budget_usd" {
  type        = number
  description = "Monthly cost budget in USD. Used only when enable_budget is true."
  default     = 5

  validation {
    condition     = var.budget_usd > 0 && var.budget_usd <= 1000
    error_message = "budget_usd must be greater than 0 and at most 1000."
  }
}

variable "budget_email" {
  type        = string
  description = "Email for budget alarms. Required when enable_budget is true."
  default     = ""
}

variable "role_name" {
  type        = string
  description = "IAM role name. Empty uses github-s3-artifact-<owner>-<repo>."
  default     = ""
}
