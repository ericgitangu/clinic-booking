provider "google" {
  # Run as the account that holds billing rights on the shared billing account
  # (developer.ericgitangu@gmail.com), NOT the project Owner. The quota project must be one the
  # caller can use; budgets are billing-scoped and rejected without it.
  project               = var.project_id
  user_project_override = true
  billing_project       = var.project_id
}
