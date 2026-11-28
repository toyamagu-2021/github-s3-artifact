locals {
  owner          = split("/", var.github_repository)[0]
  repo           = split("/", var.github_repository)[1]
  role_name      = var.role_name != "" ? var.role_name : "github-s3-artifact-${local.owner}-${local.repo}"
  subject_prefix = var.oidc_use_immutable_subject ? "repo:${local.owner}@${var.github_owner_id}/${local.repo}@${var.github_repository_id}" : "repo:${local.owner}/${local.repo}"
  sub            = "${local.subject_prefix}:environment:${var.github_environment}"
  workflow_ref   = "${var.github_repository}/${var.workflow_file}@${var.allowed_ref}"
  # AWS no longer validates these thumbprints for token.actions.githubusercontent.com,
  # and the CreateOpenIDConnectProvider API still rejects an empty list.
  github_thumbprints = [
    "6938fd4d98bab03faadb97b34396831e3780aea1",
    "1c58a3a8518e8759bf075b76b750d4f2df264fcd",
  ]
  oidc_provider_arn = var.create_oidc_provider ? aws_iam_openid_connect_provider.github[0].arn : var.existing_oidc_provider_arn
}

resource "aws_iam_openid_connect_provider" "github" {
  count = var.create_oidc_provider ? 1 : 0

  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = local.github_thumbprints
}

data "aws_iam_policy_document" "trust" {
  statement {
    sid     = "GitHubActionsThisRepo"
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:repository"
      values   = [var.github_repository]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:repository_id"
      values   = [var.github_repository_id]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:ref"
      values   = [var.allowed_ref]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:workflow_ref"
      values   = [local.workflow_ref]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:environment"
      values   = [var.github_environment]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = [local.sub]
    }

    # Allow-list. pull_request and pull_request_target do not match.
    # push is included so uncommenting that trigger later does not need another apply.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:event_name"
      values   = ["push", "workflow_dispatch"]
    }
  }
}

data "aws_iam_policy_document" "s3" {
  statement {
    sid       = "ListRepoManifests"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [var.bucket_arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["${var.object_prefix}/*"]
    }
  }

  statement {
    sid    = "ReadDeleteAndAbort"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:DeleteObject",
      "s3:AbortMultipartUpload",
    ]
    resources = ["${var.bucket_arn}/${var.object_prefix}/*"]
  }

  # PutObject lives only on this statement. An unconditional PutObject allow
  # would bypass the tag-key limit because IAM unions Allow statements.
  # ForAllValues matches when the request has no tags.
  statement {
    sid    = "WriteWithRetentionTagOnly"
    effect = "Allow"
    actions = [
      "s3:PutObject",
      "s3:PutObjectTagging",
    ]
    resources = ["${var.bucket_arn}/${var.object_prefix}/*"]

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "s3:RequestObjectTagKeys"
      values   = ["s3-artifact-retention-days"]
    }
  }
}

resource "aws_iam_role" "this" {
  name                 = local.role_name
  description          = "GitHub Actions OIDC role for github-s3-artifact on ${var.bucket_name}."
  assume_role_policy   = data.aws_iam_policy_document.trust.json
  max_session_duration = 3600

  lifecycle {
    precondition {
      condition     = !var.create_oidc_provider || length(var.existing_oidc_provider_arn) == 0
      error_message = "Leave existing_oidc_provider_arn empty when create_oidc_provider is true."
    }

    precondition {
      condition     = var.create_oidc_provider || startswith(var.existing_oidc_provider_arn, "arn:aws:iam::")
      error_message = "Set existing_oidc_provider_arn when create_oidc_provider is false."
    }

    precondition {
      condition     = !var.oidc_use_immutable_subject || can(regex("^[0-9]+$", var.github_owner_id))
      error_message = "Immutable OIDC subjects require a numeric github_owner_id."
    }

    precondition {
      condition     = length(local.role_name) <= 64 && can(regex("^[A-Za-z0-9+=,.@_-]+$", local.role_name))
      error_message = "role_name must be a valid IAM role name of at most 64 characters."
    }
  }
}

resource "aws_iam_role_policy" "s3" {
  name   = "s3-artifact"
  role   = aws_iam_role.this.id
  policy = data.aws_iam_policy_document.s3.json
}
