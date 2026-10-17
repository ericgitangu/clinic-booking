import { describe, expect, it, vi } from "vitest";
import type { RecaptchaResult } from "@clinic/api/recaptcha";
import { checkHuman, enforced } from "@/lib/human-check";

const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;
const configured = {
  NEXT_PUBLIC_RECAPTCHA_SITE_KEY: "site",
  RECAPTCHA_SERVICE_ACCOUNT_EMAIL: "clinic-recaptcha@p.iam.gserviceaccount.com",
};
const verifier = (r: RecaptchaResult) => vi.fn().mockResolvedValue(r);

describe("enforced", () => {
  it("is on by default, in development and in a production build", () => {
    expect(enforced(env({}))).toBe(true);
    expect(enforced(env({ NODE_ENV: "production" }))).toBe(true);
    expect(enforced(env({ NODE_ENV: "development" }))).toBe(true);
  });
  it("ignores RECAPTCHA_ENFORCE=false unless this is a test run", () => {
    expect(enforced(env({ RECAPTCHA_ENFORCE: "false" }))).toBe(true);
    expect(
      enforced(env({ RECAPTCHA_ENFORCE: "false", NODE_ENV: "production" })),
    ).toBe(true);
    expect(
      enforced(env({ RECAPTCHA_ENFORCE: "false", VERCEL_ENV: "preview" })),
    ).toBe(true);
  });
  it("can be switched off for NODE_ENV=test or E2E=1", () => {
    expect(
      enforced(env({ RECAPTCHA_ENFORCE: "false", NODE_ENV: "test" })),
    ).toBe(false);
    expect(
      enforced(
        env({ RECAPTCHA_ENFORCE: "false", E2E: "1", NODE_ENV: "production" }),
      ),
    ).toBe(false);
  });
  it("needs both the test marker and the setting", () => {
    expect(enforced(env({ E2E: "1" }))).toBe(true);
    expect(enforced(env({ NODE_ENV: "test" }))).toBe(true);
  });
  it("cannot be switched off in production, whatever else is set", () => {
    expect(
      enforced(
        env({
          RECAPTCHA_ENFORCE: "false",
          E2E: "1",
          NODE_ENV: "test",
          VERCEL_ENV: "production",
        }),
      ),
    ).toBe(true);
  });
});

describe("checkHuman", () => {
  it("skips the verifier only when the check is switched off for a test run", async () => {
    const verify = verifier({ ok: true, score: 1 });
    const r = await checkHuman("", "book", {
      env: env({ RECAPTCHA_ENFORCE: "false", E2E: "1" }),
      verify,
    });
    expect(r).toEqual({ ok: true });
    expect(verify).not.toHaveBeenCalled();
  });

  it("does not skip when the setting is on but this is not a test run", async () => {
    const verify = verifier({ ok: true, score: 1 });
    const r = await checkHuman("tok", "book", {
      env: env({ RECAPTCHA_ENFORCE: "false" }),
      verify,
    });
    expect(r).toEqual({ ok: false, unavailable: true });
    expect(verify).not.toHaveBeenCalled();
  });

  it("fails closed, as unavailable, when the keys are not configured", async () => {
    const verify = verifier({ ok: true, score: 1 });
    expect(await checkHuman("t", "book", { env: env({}), verify })).toEqual({
      ok: false,
      unavailable: true,
    });
    expect(verify).not.toHaveBeenCalled();
  });

  it("passes the action, token and a configured minimum score to the verifier", async () => {
    const verify = verifier({ ok: true, score: 0.9 });
    const r = await checkHuman("tok", "cancel", {
      env: env({ ...configured, RECAPTCHA_MIN_SCORE: "0.7" }),
      verify,
    });
    expect(r).toEqual({ ok: true });
    expect(verify).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "tok",
        expectedAction: "cancel",
        minScore: 0.7,
        siteKey: "site",
      }),
    );
  });

  it("falls back to the default minimum when the setting is not a number", async () => {
    const verify = verifier({ ok: true, score: 0.9 });
    await checkHuman("tok", "book", {
      env: env({ ...configured, RECAPTCHA_MIN_SCORE: "high" }),
      verify,
    });
    expect(verify).toHaveBeenCalledWith(
      expect.objectContaining({ minScore: 0.5 }),
    );
  });

  it.each([
    "missing-token",
    "invalid-token",
    "wrong-action",
    "low-score",
  ] as const)("rejects as not human on %s", async (reason) => {
    const verify = verifier({ ok: false, reason });
    expect(
      await checkHuman("tok", "book", { env: env(configured), verify }),
    ).toEqual({
      ok: false,
      unavailable: false,
    });
  });

  it("reports unavailable when Google cannot be reached", async () => {
    const verify = verifier({ ok: false, reason: "unavailable" });
    expect(
      await checkHuman("tok", "book", { env: env(configured), verify }),
    ).toEqual({
      ok: false,
      unavailable: true,
    });
  });
});
