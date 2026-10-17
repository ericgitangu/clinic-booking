# $1 ALERT-only budget on THIS PROJECT's gross spend (all services, credits excluded). It does
# not cap spend; the $3 gross Cloud Run spend cap is console-managed (see the end of this file).
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

# The $3 gross Cloud Run spend cap (clinic-run-spend-cap-3usd) is NOT managed here. Terraform and
# the Budget API cannot express a spend cap, and an existing budget cannot be converted into one;
# applying a budget of that name from code would recreate an alerts-only budget and collide with the
# console one (the console refuses a second budget for the same project and service). It is
# console-managed: see docs/evidence/spend-cap-2026-10-18.md. scripts/cost_check.sh (C11) checks that
# evidence. The cap is a backstop; the $0 mechanism is the free-tier arithmetic and the ticket budget.
