provider "aws" {
  region = var.aws_region
}

# Budgets is a us-east-1 API. The alias exists even when the alarm is disabled
# so the configuration stays valid without a second root module.
provider "aws" {
  alias  = "use1"
  region = "us-east-1"
}
