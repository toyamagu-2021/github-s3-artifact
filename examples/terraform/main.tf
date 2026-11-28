locals {
  object_prefix = "${var.key_prefix}/${var.github_repository}"
}

module "artifact_bucket" {
  source = "./modules/artifact_bucket"

  bucket_name        = var.bucket_name
  force_destroy      = var.force_destroy
  object_prefix      = local.object_prefix
  expiration_days    = var.expiration_days
  retention_tag_days = var.retention_tag_days
  enable_versioning  = var.enable_versioning
}

module "github_oidc_role" {
  source = "./modules/github_oidc_role"

  bucket_arn                 = module.artifact_bucket.bucket_arn
  bucket_name                = module.artifact_bucket.bucket_name
  object_prefix              = local.object_prefix
  github_repository          = var.github_repository
  github_repository_id       = var.github_repository_id
  github_owner_id            = var.github_owner_id
  oidc_use_immutable_subject = var.oidc_use_immutable_subject
  github_environment         = var.github_environment
  allowed_ref                = var.allowed_ref
  workflow_file              = var.workflow_file
  create_oidc_provider       = var.create_oidc_provider
  existing_oidc_provider_arn = var.existing_oidc_provider_arn
  role_name                  = var.role_name
}

resource "aws_budgets_budget" "monthly" {
  count    = var.enable_budget ? 1 : 0
  provider = aws.use1

  name         = "${var.bucket_name}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.budget_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.budget_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.budget_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.budget_email]
  }

  lifecycle {
    precondition {
      condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.budget_email))
      error_message = "Set budget_email to a real address when enable_budget is true."
    }
  }
}
