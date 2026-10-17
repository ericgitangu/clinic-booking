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

# The signing key behind the app-to-API assertion. The container already exists and holds
# its one version, added out-of-band; it is adopted here, not recreated, and no value is in state.
# Remove the import block after the first apply that has adopted it.
resource "google_secret_manager_secret" "internal_signing_key" {
  secret_id = "clinic-internal-signing-key"
  replication {
    auto {}
  }
  depends_on = [google_project_service.enabled]
}

import {
  to = google_secret_manager_secret.internal_signing_key
  id = "projects/sil-clinic-booking/secrets/clinic-internal-signing-key"
}
