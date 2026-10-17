# Optional realtime feed: the realtime gateway's identity and secret containers (docs/adr/0021, docs/adr/0014,
# docs/adr/0015, docs/adr/0022). Nothing here creates a Cloud Run service: the service is not managed by
# Terraform (plan_gate.sh bans every google_cloud_run* resource, so the cost-sensitive settings
# cannot be loosened through a plan). It is deployed by the ship-realtime job with the flags
# below, and its invoker bindings are made once by infra/bootstrap.sh (step_invoker already
# loops clinic-api and clinic-realtime over clinic-web, clinic-admin and clinic-smoke).
#
# Cloud Run settings for clinic-realtime. Scale to zero and request-based billing are binding:
# CPU is billed only while a request (a stream) is open, and nothing keeps an instance warm.
#
#   gcloud run deploy clinic-realtime --project sil-clinic-booking --region us-east4 \
#     --service-account clinic-realtime-runtime@sil-clinic-booking.iam.gserviceaccount.com \
#     --no-allow-unauthenticated --add-custom-audiences clinic-realtime \
#     --min-instances 0 --max-instances 2 --concurrency 1 \
#     --cpu 0.25 --memory 256Mi --cpu-boost --timeout 300 \
#     --set-secrets DATABASE_URL=clinic-database-url-realtime:latest,STREAM_TICKET_KEY=clinic-stream-ticket-key:latest \
#     --set-env-vars STREAM_AUTH_REQUIRED=true,MAX_STREAMS_PER_INSTANCE=1,GOMEMLIMIT=200MiB,PROBLEMS_BASE_URL=<public API origin>
#
# Never add: --no-cpu-throttling or any instance-based billing (it bills the instance while idle
# and defeats scale to zero), --min-instances above 0, --allow-unauthenticated,
# --no-invoker-iam-check, a startup/liveness probe that opens a database connection (/health does
# no I/O, so a probe cannot wake Neon), or any scheduler, uptime check or keep-warm ping.
#
# If Cloud Run rejects --cpu 0.25 with --memory 256Mi, docs/adr/0014's fallback is --cpu 0.5 (keep
# --concurrency 1); change it only in the ship-realtime deploy command and then recompute the
# cost table. The real error text must be recorded in docs/adr/0014.

resource "google_service_account" "realtime_runtime" {
  account_id   = "clinic-realtime-runtime"
  display_name = "clinic-realtime runtime"
  depends_on   = [google_project_service.enabled]
}

# Containers only. Versions are added out of band (docs/runbooks/neon.md for the database URL of
# the read-only clinic_realtime role); no value ever passes through Terraform or its state.
resource "google_secret_manager_secret" "database_url_realtime" {
  secret_id = "clinic-database-url-realtime"
  replication {
    auto {}
  }
  depends_on = [google_project_service.enabled]
}

# The HMAC key clinic-api signs stream tickets with and the gateway verifies them with
# (docs/adr/0022). The container is created here because the gateway is its second consumer;
# clinic-api's accessor binding belongs with the lane that adds the ticket endpoint.
resource "google_secret_manager_secret" "stream_ticket_key" {
  secret_id = "clinic-stream-ticket-key"
  replication {
    auto {}
  }
  depends_on = [google_project_service.enabled]
}

resource "google_secret_manager_secret_iam_member" "realtime_database_url" {
  secret_id = google_secret_manager_secret.database_url_realtime.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.realtime_runtime.email}"
}

resource "google_secret_manager_secret_iam_member" "realtime_stream_ticket_key" {
  secret_id = google_secret_manager_secret.stream_ticket_key.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.realtime_runtime.email}"
}

# ship-realtime deploys with --service-account, which needs act-as on exactly this account.
resource "google_service_account_iam_member" "deployer_act_as_realtime" {
  service_account_id = google_service_account.realtime_runtime.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.deployer.email}"
}
