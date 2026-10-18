# The push service key. The secret was created by hand (never by Terraform), holds its one
# version out-of-band, and is READ here only as a reference: no value, no version and no container
# is managed, so nothing secret reaches the state. What Terraform owns is the one grant that lets
# the API's runtime identity read it (`--set-secrets ABLY_API_KEY=clinic-ably-api-key:latest`).
data "google_secret_manager_secret" "ably_api_key" {
  secret_id = "clinic-ably-api-key"
  project   = var.project_id
}

resource "google_secret_manager_secret_iam_member" "runtime_ably_key" {
  secret_id = data.google_secret_manager_secret.ably_api_key.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.api_runtime.email}"
}
