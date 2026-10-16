# One free exclusion on the _Default sink: drop Cloud Run platform request-log lines for
# IAM-denied requests (401/403). The logName clause keeps the app's own stdout logs, so an
# app-emitted 401/403 (optional admin features) is still logged; only the platform request-log line is dropped.
resource "google_logging_project_exclusion" "drop_iam_denied" {
  name   = "drop-iam-denied"
  filter = "resource.type=\"cloud_run_revision\" AND logName:\"run.googleapis.com%2Frequests\" AND (httpRequest.status=401 OR httpRequest.status=403)"
}
