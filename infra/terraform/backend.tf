# State lives in the bootstrap-created bucket (infra/bootstrap.sh). The bucket name is
# clinic-tfstate-<project>; pass it with `terraform init -backend-config=bucket=...`.
# State holds no secret values (secret containers only, no versions).
terraform {
  backend "gcs" {
    prefix = "clinic/infra"
  }
}
