# $1 ALERT-only budget, scoped to the whole billing account so any other project sharing the
# free tiers shows up. This does NOT cap spend; the $3 gross Cloud Run spend cap is set in
# bootstrap.sh / console (Budget API spend-cap support is unverified, WP-00 (c)).
resource "google_billing_budget" "alerts_1usd" {
  billing_account = var.billing_account
  display_name    = "clinic-alerts-1usd"

  amount {
    specified_amount {
      currency_code = "USD"
      units         = "1"
    }
  }

  threshold_rules {
    threshold_percent = 0.5
  }
  threshold_rules {
    threshold_percent = 0.9
  }
  threshold_rules {
    threshold_percent = 1.0
  }

  depends_on = [google_project_service.enabled]
}
