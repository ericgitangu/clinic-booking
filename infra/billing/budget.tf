# $1 ALERT-only budget, scoped to the whole billing account so any other project sharing the
# free tiers shows up. This does NOT cap spend; the $3 gross Cloud Run spend cap is set in
# bootstrap.sh / console (Budget API spend-cap support is unverified).
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

# $3 GROSS Cloud Run budget: scoped to this project and the Cloud Run service, credits excluded,
# so it reads the cost before the free-tier discount. The provider and the CLI expose notification
# wiring only; there is no attribute that pauses or caps usage. Turning this budget into an
# enforced cap is a console action (see the runbook) and cannot be verified from code.
resource "google_billing_budget" "run_spend_cap_3usd" {
  billing_account = var.billing_account
  display_name    = "clinic-run-spend-cap-3usd"

  budget_filter {
    projects               = ["projects/${var.project_number}"]
    services               = ["services/152E-C115-5142"] # Cloud Run
    credit_types_treatment = "EXCLUDE_ALL_CREDITS"
  }

  amount {
    specified_amount {
      currency_code = "USD"
      units         = "3"
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
