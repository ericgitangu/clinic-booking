# Secret CONTAINERS only; versions are added out-of-band by the Neon runbook
# (printf %s "$URL" | gcloud secrets versions add ...). No secret values in Terraform/state.
resource "google_secret_manager_secret" "database_url_app" {
  secret_id = "clinic-database-url-app"
  replication {
    auto {}
  }
  depends_on = [google_project_service.enabled]
}

resource "google_secret_manager_secret" "database_url_migrate" {
  secret_id = "clinic-database-url-migrate"
  replication {
    auto {}
  }
  depends_on = [google_project_service.enabled]
}
