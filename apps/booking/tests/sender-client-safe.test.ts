import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Playwright specs (e2e/emails.spec.ts) import the sender constants in plain Node, where the
// `server-only` package throws. So the module they import must not reach it, directly or through
// @clinic/api/mail (which holds the Resend key and is server-only on purpose).
describe("the sender constants are safe outside a server component", () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
  const sender = read("../src/lib/email/sender.ts");
  const constants = read("../../../packages/api/src/mail-constants.ts");

  it("sender.ts imports only the constants module", () => {
    expect(sender).toContain('"@clinic/api/mail-constants"');
    expect(sender).not.toMatch(/from "@clinic\/api\/mail"/);
    expect(sender).not.toContain("server-only");
  });
  it("the constants module imports nothing", () => {
    expect(constants).not.toMatch(/^\s*import\b/m);
  });
  it("the sending module stays server-only", () => {
    expect(read("../../../packages/api/src/mail.ts")).toContain(
      'import "server-only"',
    );
  });
});
