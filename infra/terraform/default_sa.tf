# The default Compute Engine service account holds roles/editor on a new project (GCP default).
# Nothing here runs as it: every Cloud Run service and job is deployed with an explicit
# --service-account (cost_check rule "run deploy missing --service-account", live check C20).
# DEPRIVILEGE removes only that Editor grant; the account itself is left in place.
resource "google_project_default_service_accounts" "deprivilege" {
  project = var.project_id
  action  = "DEPRIVILEGE"

  depends_on = [google_project_service.enabled]
}
