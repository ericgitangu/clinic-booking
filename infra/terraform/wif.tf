# CircleCI -> GCP via Workload Identity Federation (keyless deploy).
resource "google_iam_workload_identity_pool" "circleci" {
  workload_identity_pool_id = "circleci"
  display_name              = "CircleCI"
  depends_on                = [google_project_service.enabled]
}

resource "google_iam_workload_identity_pool_provider" "circleci" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.circleci.workload_identity_pool_id
  workload_identity_pool_provider_id = "circleci-oidc"

  # google.subject must stay < 127 bytes: project UUID + ':refs/heads/main' is ~52 bytes.
  # NEVER map assertion.sub (160+ bytes).
  attribute_mapping = {
    "google.subject"       = "assertion['oidc.circleci.com/project-id'] + ':' + assertion['oidc.circleci.com/vcs-ref']"
    "attribute.project_id" = "assertion['oidc.circleci.com/project-id']"
  }

  attribute_condition = "assertion['oidc.circleci.com/project-id'] == '${var.circleci_project_id}' && assertion['oidc.circleci.com/vcs-ref'] == 'refs/heads/main'"

  oidc {
    issuer_uri        = "https://oidc.circleci.com/org/${var.circleci_org_id}"
    allowed_audiences = [var.circleci_org_id]
  }
}

# The deployer SA is impersonable only from this CircleCI project; the main-only restriction
# lives in attribute_condition above.
resource "google_service_account_iam_member" "deployer_wif" {
  service_account_id = google_service_account.deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.circleci.name}/attribute.project_id/${var.circleci_project_id}"
}
