# $1 ALERT-only budget on THIS PROJECT's gross spend (all services, credits excluded). It does
# not cap spend; the $3 gross Cloud Run spend cap is a console action (Budget API spend-cap
# support is unverified).
#
# It was account-wide while the billing account was meant to be dedicated. The account is SHARED
# (PLAN 11.1 Q14) and the other projects already bill about $5 a month of Artifact Registry
# storage and Secret Manager versions (PLAN 13.8), so an account-wide $1 alert would fire
# permanently and say nothing about this project.
resource "google_billing_budget" "alerts_1usd" {
  billing_account = var.billing_account
  display_name    = "clinic-alerts-1usd"

  budget_filter {
    projects               = ["projects/${var.project_number}"]
    credit_types_treatment = "EXCLUDE_ALL_CREDITS"
  }

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
}
