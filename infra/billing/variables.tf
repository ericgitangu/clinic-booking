variable "project_id" {
  type        = string
  description = "GCP project id (sil-clinic-booking). Used as the quota project and in the budget filter."
}

variable "project_number" {
  type        = string
  description = "GCP project number (291652953712). Used in the Cloud Run budget filter."
}

variable "billing_account" {
  type        = string
  description = "SHARED billing account id (01C382-12CD13-DCA6EF, 'Firebase Payment'). Not dedicated: see PLAN 11.1 Q14."
}
