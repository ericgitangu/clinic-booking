import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

// The retired names (the clinic's old name and the old product name "Idyllic Clinic Booking") must
// not show on any public page of this app, its manifest, or /api/doctors. The same script the
// release runs against production after a deploy (scripts/ci/check_retired_names.sh), here against
// the real build, API and seeded database. Skip-free: it is green only when every copy edit has merged.
const SCRIPT = fileURLToPath(
  new URL("../../../scripts/ci/check_retired_names.sh", import.meta.url),
);

test("no retired name on any public page, the manifest or /api/doctors", ({
  baseURL,
}) => {
  let output = "";
  try {
    output = execFileSync("bash", [SCRIPT, baseURL as string], {
      encoding: "utf8",
    });
  } catch (err) {
    output = (err as { stdout?: string }).stdout ?? String(err);
  }
  expect(output).toContain("none on any checked surface");
  expect(output).toContain("/api/doctors"); // the data endpoint was among the surfaces checked
});
