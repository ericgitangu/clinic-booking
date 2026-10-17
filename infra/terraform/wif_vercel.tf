# Vercel -> GCP via WIF. Each app's server side mints a Google ID token for Cloud Run directly
# (generateIdToken), so each project's principal gets the OpenID-token-creator role on its own
# service account: clinic-web on clinic-web, clinic-admin on clinic-admin. The provider admits
# exactly those two production subjects.
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
  attribute_condition = "assertion.sub in ['owner:${var.vercel_team}:project:clinic-web:environment:production', 'owner:${var.vercel_team}:project:clinic-admin:environment:production']"

  oidc {
    issuer_uri        = "https://oidc.vercel.com/${var.vercel_team}"
    allowed_audiences = ["https://vercel.com/${var.vercel_team}"]
  }
}

locals {
  vercel_subject_base    = "principal://iam.googleapis.com/projects/${var.project_number}/locations/global/workloadIdentityPools/vercel/subject/owner:${var.vercel_team}:project"
  vercel_principal       = "${local.vercel_subject_base}:clinic-web:environment:production"
  vercel_admin_principal = "${local.vercel_subject_base}:clinic-admin:environment:production"
}

# Direct federated generateIdToken (unverified until the first live Vercel deploy). Fallback if the
# direct call is denied: swap this role for roles/iam.workloadIdentityUser (a superset that
# includes iam.serviceAccounts.getOpenIdToken) on the same principal, same single call.
resource "google_service_account_iam_member" "vercel_mint_id_token" {
  service_account_id = google_service_account.web.name
  role               = "roles/iam.serviceAccountOpenIdTokenCreator"
  member             = local.vercel_principal
}

resource "google_service_account_iam_member" "vercel_admin_mint_id_token" {
  service_account_id = google_service_account.admin.name
  role               = "roles/iam.serviceAccountOpenIdTokenCreator"
  member             = local.vercel_admin_principal
}
