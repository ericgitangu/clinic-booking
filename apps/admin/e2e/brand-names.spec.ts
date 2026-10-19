import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

// The retired names (the clinic's old name and the old product name "Idyllic Clinic Booking") must
// not show on the admin app's public pages or manifest. The same script the release runs against
// production after a deploy (scripts/ci/check_retired_names.sh), here against the real build.
const SCRIPT = fileURLToPath(
  new URL("../../../scripts/ci/check_retired_names.sh", import.meta.url),
);

test("no retired name on the admin app's public pages or manifest", ({
  baseURL,
}) => {
  let output = "";
  try {
    output = execFileSync("bash", [SCRIPT, "-", baseURL as string], {
      encoding: "utf8",
    });
  } catch (err) {
    const e = err as { stdout?: string };
    output = e.stdout ?? String(err);
  }
  expect(output).toContain("none on any checked surface");
  expect(output).toContain("/manifest.webmanifest");
});
