# Enabled APIs only. Paid image scanners and the managed build service are intentionally
# excluded: Artifact Analysis bills per image with no free tier, and the build service makes
# extra buckets/repos outside the free regions ($0 audit, ADR-0016). Image scanning stays in
# CI (Trivy). Adding any API here is recounted against §13.

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
    "logging.googleapis.com",
  ]
}

resource "google_project_service" "enabled" {
  for_each                   = toset(local.services)
  service                    = each.value
  disable_dependent_services = false
  disable_on_destroy         = false
}
