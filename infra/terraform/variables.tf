variable "project_id" {
  type        = string
  description = "GCP project id (e.g. sil-clinic-booking)."
}

variable "project_number" {
  type        = string
  description = "GCP project number (used in WIF principal strings)."
}

variable "region" {
  type        = string
  default     = "us-east4"
  description = "Cloud Run / Artifact Registry region (Tier 1, North America free egress)."
}

variable "circleci_org_id" {
  type        = string
  description = "CircleCI organization id (OIDC issuer segment and audience)."
}

variable "circleci_project_id" {
  type        = string
  description = "CircleCI project id (OIDC subject condition)."
}

variable "vercel_team" {
  type        = string
  description = "Vercel team slug (OIDC issuer segment and subject condition)."
}

variable "alert_email" {
  type        = string
  description = "Recipient for the egress alert notification channel."
}

variable "circleci_gcp_deploy_context_id" {
  type        = string
  description = "UUID of the CircleCI gcp-deploy context. Only jobs that use this context can mint a deployer token."
}

variable "github_repository" {
  type        = string
  default     = "ericgitangu/clinic-booking"
  description = "owner/name of the GitHub repository; matched against the OIDC vcs-origin claim."
}
