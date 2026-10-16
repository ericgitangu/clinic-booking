# Vercel -> GCP via WIF. The web project's proxy mints a Google ID token for Cloud Run
# directly (generateIdToken), so clinic-web gets the OpenID-token-creator role (ADR-0023).
resource "google_iam_workload_identity_pool" "vercel" {
  workload_identity_pool_id = "vercel"
  display_name              = "Vercel"
  depends_on                = [google_project_service.enabled]
}

resource "google_iam_workload_identity_pool_provider" "vercel" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.vercel.workload_identity_pool_id
  workload_identity_pool_provider_id = "vercel"

  attribute_mapping = {
    "google.subject" = "assertion.sub"
  }
  attribute_condition = "assertion.sub == 'owner:${var.vercel_team}:project:clinic-web:environment:production'"

  oidc {
    issuer_uri        = "https://oidc.vercel.com/${var.vercel_team}"
    allowed_audiences = ["https://vercel.com/${var.vercel_team}"]
  }
}

locals {
  vercel_principal = "principal://iam.googleapis.com/projects/${var.project_number}/locations/global/workloadIdentityPools/vercel/subject/owner:${var.vercel_team}:project:clinic-web:environment:production"
}

# Direct federated generateIdToken (unverified until Part C acceptance; K38). Fallback if the
# direct call is denied: swap this role for roles/iam.workloadIdentityUser (a superset that
# includes iam.serviceAccounts.getOpenIdToken) on the same principal, same single call.
resource "google_service_account_iam_member" "vercel_mint_id_token" {
  service_account_id = google_service_account.web.name
  role               = "roles/iam.serviceAccountOpenIdTokenCreator"
  member             = local.vercel_principal
}
