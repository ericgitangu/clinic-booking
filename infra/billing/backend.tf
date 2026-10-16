# Same state bucket as infra/terraform (clinic-tfstate-<project>), separate prefix: this root
# runs as the billing identity, the other as the project Owner, so they cannot share a state
# without one of them lacking rights over the other's resources.
terraform {
  backend "gcs" {
    prefix = "clinic/billing"
  }
}
