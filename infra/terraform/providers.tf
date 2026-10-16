provider "google" {
  project = var.project_id
  region  = var.region

  # Run Terraform as the engineer's own user credentials (see the runbook), not whatever ADC
  # happens to be present. Billing-scoped APIs (budgets) are attributed to the quota project;
  # without these two settings user-ADC calls to them are billed to, and rejected by, the
  # quota project stored in the ADC file.
  user_project_override = true
  billing_project       = var.project_id
}
