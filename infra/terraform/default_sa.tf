# The default Compute Engine service account holds roles/editor on a new project (GCP default).
# Nothing here runs as it: every Cloud Run service and job is deployed with an explicit
# --service-account (cost_check rule "run deploy missing --service-account", live check C20).
#
# google_project_default_service_accounts (DEPRIVILEGE) was tried first and left the binding in
# place: it applied cleanly but reported no default accounts and changed nothing. Removing the one
# binding by name does the job and is checked by the live default-SA check.
resource "google_project_iam_member_remove" "default_compute_editor" {
  project = var.project_id
  role    = "roles/editor"
  member  = "serviceAccount:${var.project_number}-compute@developer.gserviceaccount.com"

  depends_on = [google_project_service.enabled]
}
