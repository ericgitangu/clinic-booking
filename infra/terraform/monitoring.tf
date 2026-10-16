# One email channel + one alert on Cloud Run sent bytes summed per day across the project.
# Threshold 30 MB/day (~1 GiB/month is ~34.6 MB/day). Alerting is free until >= 2027-09-01
# (then $0.35/metric-reference/month); delete this policy + channel or re-verify the cost
# before 2027-08-01. No uptime checks.
resource "google_monitoring_notification_channel" "email" {
  display_name = "clinic-alert-email"
  type         = "email"
  labels = {
    email_address = var.alert_email
  }
  depends_on = [google_project_service.enabled]
}

resource "google_monitoring_alert_policy" "egress_daily" {
  display_name = "clinic-run-egress-daily"
  combiner     = "OR"

  conditions {
    display_name = "Cloud Run sent bytes > 30MB/day"
    condition_threshold {
      filter          = "resource.type = \"cloud_run_revision\" AND metric.type = \"run.googleapis.com/container/network/sent_bytes_count\""
      comparison      = "COMPARISON_GT"
      threshold_value = 30000000
      duration        = "0s"
      aggregations {
        alignment_period     = "86400s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.email.id]
}
