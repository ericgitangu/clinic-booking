import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clinic/api/recaptcha", () => ({
  DEFAULT_MIN_SCORE: 0.5,
  verifyRecaptcha: vi.fn(),
}));
import { verifyRecaptcha } from "@clinic/api/recaptcha";
import { checkHuman, enforced } from "@/lib/human-check";

const configured = {
  NEXT_PUBLIC_RECAPTCHA_SITE_KEY: "site",
  RECAPTCHA_SERVICE_ACCOUNT_EMAIL: "clinic-recaptcha@p.iam.gserviceaccount.com",
} as unknown as NodeJS.ProcessEnv;

beforeEach(() => vi.mocked(verifyRecaptcha).mockReset());

describe("enforced", () => {
  it("is on by default", () => {
    expect(enforced({} as NodeJS.ProcessEnv)).toBe(true);
  });
  it("can be switched off outside production", () => {
    expect(
      enforced({ RECAPTCHA_ENFORCE: "false" } as unknown as NodeJS.ProcessEnv),
    ).toBe(false);
    expect(
      enforced({
        RECAPTCHA_ENFORCE: "false",
        VERCEL_ENV: "preview",
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(false);
  });
  it("cannot be switched off in production", () => {
    expect(
      enforced({
        RECAPTCHA_ENFORCE: "false",
        VERCEL_ENV: "production",
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(true);
  });
});

describe("checkHuman", () => {
  it("skips the check when not enforced", async () => {
    const r = await checkHuman("", "book", {
      RECAPTCHA_ENFORCE: "false",
    } as unknown as NodeJS.ProcessEnv);
    expect(r).toEqual({ ok: true });
    expect(verifyRecaptcha).not.toHaveBeenCalled();
  });

  it("fails closed, as unavailable, when the keys are not configured", async () => {
    const r = await checkHuman("t", "book", {} as NodeJS.ProcessEnv);
    expect(r).toEqual({ ok: false, unavailable: true });
  });

  it("passes the action and a configured minimum score to the verifier", async () => {
    vi.mocked(verifyRecaptcha).mockResolvedValue({ ok: true, score: 0.9 });
    const r = await checkHuman("tok", "cancel", {
      ...configured,
      RECAPTCHA_MIN_SCORE: "0.7",
    } as unknown as NodeJS.ProcessEnv);
    expect(r).toEqual({ ok: true });
    expect(verifyRecaptcha).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "tok",
        expectedAction: "cancel",
        minScore: 0.7,
        siteKey: "site",
      }),
    );
  });

  it("falls back to the default minimum when the setting is not a number", async () => {
    vi.mocked(verifyRecaptcha).mockResolvedValue({ ok: true, score: 0.9 });
    await checkHuman("tok", "book", {
      ...configured,
      RECAPTCHA_MIN_SCORE: "high",
    } as unknown as NodeJS.ProcessEnv);
    expect(verifyRecaptcha).toHaveBeenCalledWith(
      expect.objectContaining({ minScore: 0.5 }),
    );
  });

  it.each([
    "missing-token",
    "invalid-token",
    "wrong-action",
    "low-score",
  ] as const)("rejects as not human on %s", async (reason) => {
    vi.mocked(verifyRecaptcha).mockResolvedValue({ ok: false, reason });
    expect(await checkHuman("tok", "book", configured)).toEqual({
      ok: false,
      unavailable: false,
    });
  });

  it("reports unavailable when Google cannot be reached", async () => {
    vi.mocked(verifyRecaptcha).mockResolvedValue({
      ok: false,
      reason: "unavailable",
    });
    expect(await checkHuman("tok", "book", configured)).toEqual({
      ok: false,
      unavailable: true,
    });
  });
});
