import { describe, expect, it, vi } from "vitest";
import { verifyRecaptcha, type RecaptchaDeps } from "../src/recaptcha";

const SA = "clinic-recaptcha@sil-clinic-booking.iam.gserviceaccount.com";
const base = {
  siteKey: "site-key",
  serviceAccount: SA,
  expectedAction: "book",
};

function deps(
  body: unknown,
  status = 200,
): RecaptchaDeps & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    accessToken: async () => "access",
    fetchImpl: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch,
  };
}

const good = {
  tokenProperties: { valid: true, action: "book" },
  riskAnalysis: { score: 0.9 },
};

describe("verifyRecaptcha", () => {
  it("accepts a valid token for the expected action with a good score", async () => {
    const d = deps(good);
    const r = await verifyRecaptcha({ ...base, token: "t" }, d);
    expect(r).toEqual({ ok: true, score: 0.9 });
    const call = d.calls[0] as { url: string; init: RequestInit };
    expect(call.url).toBe(
      "https://recaptchaenterprise.googleapis.com/v1/projects/sil-clinic-booking/assessments",
    );
    expect(JSON.parse(call.init.body as string)).toEqual({
      event: { token: "t", siteKey: "site-key", expectedAction: "book" },
    });
  });

  it("accepts a score exactly at the minimum", async () => {
    const r = await verifyRecaptcha(
      { ...base, token: "t", minScore: 0.5 },
      deps({ ...good, riskAnalysis: { score: 0.5 } }),
    );
    expect(r.ok).toBe(true);
  });

  it.each([undefined, null, ""])(
    "rejects a missing token (%s) without calling Google",
    async (token) => {
      const d = deps(good);
      const r = await verifyRecaptcha({ ...base, token }, d);
      expect(r).toEqual({ ok: false, reason: "missing-token" });
      expect(d.calls).toHaveLength(0);
    },
  );

  it("rejects a token Google says is invalid", async () => {
    const r = await verifyRecaptcha(
      { ...base, token: "t" },
      deps({ tokenProperties: { valid: false, invalidReason: "EXPIRED" } }),
    );
    expect(r).toEqual({
      ok: false,
      reason: "invalid-token",
      detail: "EXPIRED",
    });
  });

  it("rejects a token issued for a different action", async () => {
    const r = await verifyRecaptcha(
      { ...base, token: "t" },
      deps({ ...good, tokenProperties: { valid: true, action: "cancel" } }),
    );
    expect(r).toEqual({ ok: false, reason: "wrong-action", detail: "cancel" });
  });

  it("rejects a token with no action at all", async () => {
    const r = await verifyRecaptcha(
      { ...base, token: "t" },
      deps({ ...good, tokenProperties: { valid: true } }),
    );
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe("wrong-action");
  });

  it("rejects a score below the minimum", async () => {
    const r = await verifyRecaptcha(
      { ...base, token: "t", minScore: 0.7 },
      deps({ ...good, riskAnalysis: { score: 0.69 } }),
    );
    expect(r).toEqual({ ok: false, reason: "low-score", detail: "0.69" });
  });

  it("uses 0.5 as the default minimum", async () => {
    const r = await verifyRecaptcha(
      { ...base, token: "t" },
      deps({ ...good, riskAnalysis: { score: 0.3 } }),
    );
    expect(!r.ok && r.reason).toBe("low-score");
  });

  it("fails closed when no score comes back", async () => {
    const r = await verifyRecaptcha(
      { ...base, token: "t" },
      deps({ tokenProperties: { valid: true, action: "book" } }),
    );
    expect(!r.ok && r.reason).toBe("unavailable");
  });

  it("fails closed when Google answers with an error", async () => {
    const r = await verifyRecaptcha(
      { ...base, token: "t" },
      deps({ error: "x" }, 403),
    );
    expect(!r.ok && r.reason).toBe("unavailable");
  });

  it("fails closed when the call throws, and never leaks a JWT into the detail", async () => {
    const d: RecaptchaDeps = {
      accessToken: async () => "access",
      fetchImpl: vi.fn().mockRejectedValue(new Error("boom eyJabc.def.ghi")),
    };
    const r = await verifyRecaptcha({ ...base, token: "t" }, d);
    expect(!r.ok && r.reason).toBe("unavailable");
    expect(JSON.stringify(r)).not.toContain("eyJabc");
  });

  it("fails closed when it cannot get an access token", async () => {
    const d: RecaptchaDeps = {
      accessToken: async () => {
        throw new Error("no sts");
      },
      fetchImpl: fetch,
    };
    const r = await verifyRecaptcha({ ...base, token: "t" }, d);
    expect(!r.ok && r.reason).toBe("unavailable");
  });

  it("rejects a service account that is not a project service account", async () => {
    const r = await verifyRecaptcha(
      { ...base, serviceAccount: "someone@example.com", token: "t" },
      deps(good),
    );
    expect(!r.ok && r.reason).toBe("unavailable");
  });
});
