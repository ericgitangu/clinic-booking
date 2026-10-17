# Enabled APIs only. Paid image scanners and the managed build service are intentionally
# excluded: Artifact Analysis bills per image with no free tier, and the build service makes
# extra buckets/repos outside the free regions. Image scanning stays in
# CI (Trivy). Re-check the free-tier cost before enabling any API here.

locals {
  services = [
    "run.googleapis.com",
    "artifactregistry.googleapis.com",
    "secretmanager.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "sts.googleapis.com",
    "billingbudgets.googleapis.com",
    "monitoring.googleapis.com",
    "recaptchaenterprise.googleapis.com", # score-based reCAPTCHA keys and assessments (ADR-0022)
    "logging.googleapis.com",
    "cloudresourcemanager.googleapis.com", # project IAM bindings
    "serviceusage.googleapis.com",         # enabling/reading APIs, user_project_override
  ]
}

resource "google_project_service" "enabled" {
  for_each                   = toset(local.services)
  service                    = each.value
  disable_dependent_services = false
  disable_on_destroy         = false
}
