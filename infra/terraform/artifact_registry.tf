# Docker repo with cleanup policies: keep the newest 2 versions, delete untagged, delete
# older than 7d (KEEP wins over DELETE). Target: <= 2 versions/package, sizeBytes < 400 MB.
resource "google_artifact_registry_repository" "clinic" {
  location      = var.region
  repository_id = "clinic"
  format        = "DOCKER"
  description   = "Clinic API images"

  cleanup_policies {
    id     = "keep-2"
    action = "KEEP"
    most_recent_versions {
      keep_count = 2
    }
  }
  cleanup_policies {
    id     = "delete-untagged"
    action = "DELETE"
    condition {
      tag_state = "UNTAGGED"
    }
  }
  cleanup_policies {
    id     = "delete-old"
    action = "DELETE"
    condition {
      older_than = "604800s" # 7d
    }
  }

  depends_on = [google_project_service.enabled]
}
