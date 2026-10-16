import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  _clearCacheForTests,
  mintIdToken,
  type MintDeps,
} from "@/lib/proxy/gcp-id-token";

function jwtWithExp(expSeconds: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString(
    "base64url",
  );
  return `h.${payload}.s`;
}

function deps(
  token: string,
  oidc: () => Promise<string>,
  now: () => number,
): MintDeps {
  const fetchImpl = (async (url: string) => {
    if (url.includes("sts.googleapis.com")) {
      return new Response(JSON.stringify({ access_token: "STS" }), {
        status: 200,
      });
    }
    return new Response(JSON.stringify({ token }), { status: 200 });
  }) as unknown as typeof fetch;
  return { oidcToken: oidc, fetchImpl, now };
}

beforeEach(() => {
  _clearCacheForTests();
  process.env.GCP_PROJECT_NUMBER = "123";
  process.env.GCP_SERVICE_ACCOUNT_EMAIL =
    "clinic-web@p.iam.gserviceaccount.com";
});

describe("mintIdToken", () => {
  it("caches per audience and does not re-mint while fresh", async () => {
    const now = 1_000_000;
    const oidc = vi.fn(async () => "VERCEL_OIDC");
    const token = jwtWithExp(now / 1000 + 3600); // 1h out
    const d = deps(token, oidc, () => now);

    const a1 = await mintIdToken("clinic-api", d);
    const a2 = await mintIdToken("clinic-api", d);
    expect(a1).toBe(token);
    expect(a2).toBe(token);
    expect(oidc).toHaveBeenCalledTimes(1); // cached second time

    await mintIdToken("clinic-realtime", d);
    expect(oidc).toHaveBeenCalledTimes(2); // different audience -> fresh mint
  });

  it("re-mints once the token is within 5 minutes of exp", async () => {
    let now = 1_000_000;
    const oidc = vi.fn(async () => "VERCEL_OIDC");
    const token = jwtWithExp(now / 1000 + 4 * 60); // 4 min out -> inside the 5 min skew
    const d = deps(token, oidc, () => now);

    await mintIdToken("clinic-api", d);
    now += 1000;
    await mintIdToken("clinic-api", d);
    expect(oidc).toHaveBeenCalledTimes(2); // refreshed, not served stale
  });
});
