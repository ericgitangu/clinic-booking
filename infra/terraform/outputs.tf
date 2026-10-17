output "deployer_sa_email" {
  value = google_service_account.deployer.email
}

output "web_sa_email" {
  value = google_service_account.web.email
}

output "smoke_sa_email" {
  value = google_service_account.smoke.email
}

output "api_runtime_sa_email" {
  value = google_service_account.api_runtime.email
}

output "migrate_sa_email" {
  value = google_service_account.migrate.email
}

output "artifact_registry_repo" {
  value = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.clinic.repository_id}"
}

output "circleci_wif_provider" {
  value = google_iam_workload_identity_pool_provider.circleci.name
}

output "vercel_wif_provider" {
  value = google_iam_workload_identity_pool_provider.vercel.name
}

output "admin_sa_email" {
  value = google_service_account.admin.email
}
