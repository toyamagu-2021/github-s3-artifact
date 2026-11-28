variable "bucket_name" {
  type        = string
  description = "Globally unique artifact bucket name."
}

variable "force_destroy" {
  type        = bool
  description = "Delete remaining objects on terraform destroy."
}

variable "object_prefix" {
  type        = string
  description = "Key prefix scoped to one repository: <key_prefix>/<owner>/<repo>."
}

variable "expiration_days" {
  type        = number
  description = "Days after which every object under object_prefix expires."
}

variable "retention_tag_days" {
  type        = list(number)
  description = "Tag values of s3-artifact-retention-days that expire after that many days."
}

variable "enable_versioning" {
  type        = bool
  description = "Turn on bucket versioning and expire noncurrent versions after one day."
}
