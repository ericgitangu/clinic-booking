import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  _clearCacheForTests,
  mintIdToken,
  type MintDeps,
  TokenMintError,
} from "../src/proxy/gcp-id-token";

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

function failingDeps(
  stsStatus: number,
  idStatus: number,
  body: string,
): MintDeps {
  const fetchImpl = (async (url: string) => {
    if (url.includes("sts.googleapis.com")) {
      return stsStatus === 200
        ? new Response(JSON.stringify({ access_token: "STS" }), { status: 200 })
        : new Response(body, { status: stsStatus });
    }
    return new Response(body, { status: idStatus });
  }) as unknown as typeof fetch;
  return {
    oidcToken: async () => "VERCEL_OIDC_SECRET",
    fetchImpl,
    now: () => 1_000_000,
  };
}

describe("mint failures are diagnosable and never leak a token", () => {
  it("an STS rejection reports the stage and status", async () => {
    const err = await mintIdToken(
      "clinic-api",
      failingDeps(403, 200, '{"error":"invalid_grant"}'),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(TokenMintError);
    expect(err).toMatchObject({ stage: "sts", status: 403 });
    expect(err.detail).toContain("invalid_grant");
  });

  it("a generateIdToken rejection reports its own stage", async () => {
    const err = await mintIdToken(
      "clinic-api",
      failingDeps(200, 403, '{"error":{"status":"PERMISSION_DENIED"}}'),
    ).catch((e) => e);
    expect(err).toMatchObject({ stage: "generateIdToken", status: 403 });
    expect(err.detail).toContain("PERMISSION_DENIED");
  });

  it("a JWT echoed in an error body is redacted", async () => {
    const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl";
    const err = await mintIdToken(
      "clinic-api",
      failingDeps(400, 200, `bad subject_token ${jwt}`),
    ).catch((e) => e);
    expect(err.detail).not.toContain("eyJ");
    expect(err.detail).toContain("[redacted-jwt]");
    expect(String(err.message)).not.toContain("VERCEL_OIDC_SECRET");
  });

  it("missing configuration fails at the config stage instead of calling Google", async () => {
    delete process.env.GCP_PROJECT_NUMBER;
    const fetchImpl = vi.fn();
    const deps: MintDeps = {
      oidcToken: async () => "x",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => 1,
    };
    const err = await mintIdToken("clinic-api", deps).catch((e) => e);
    expect(err).toMatchObject({ stage: "config" });
    expect(err.detail).toContain("GCP_PROJECT_NUMBER");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("an empty service account email is also a config error", async () => {
    process.env.GCP_SERVICE_ACCOUNT_EMAIL = "";
    const err = await mintIdToken(
      "clinic-api",
      failingDeps(200, 200, ""),
    ).catch((e) => e);
    expect(err).toMatchObject({ stage: "config" });
    expect(err.detail).toContain("GCP_SERVICE_ACCOUNT_EMAIL");
  });
});

describe("concurrent cold requests share one mint", () => {
  it("runs STS and generateIdToken once for N simultaneous callers", async () => {
    const now = 1_000_000;
    const oidc = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return "VERCEL_OIDC";
    });
    const token = jwtWithExp(now / 1000 + 3600);
    const d = deps(token, oidc, () => now);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => mintIdToken("clinic-api", d)),
    );
    expect(new Set(results)).toEqual(new Set([token]));
    expect(oidc).toHaveBeenCalledTimes(1);
  });

  it("a failed mint is not cached: the next caller tries again", async () => {
    await mintIdToken("clinic-api", failingDeps(500, 200, "boom")).catch(
      () => undefined,
    );
    const now = 1_000_000;
    const oidc = vi.fn(async () => "VERCEL_OIDC");
    const token = jwtWithExp(now / 1000 + 3600);
    await expect(
      mintIdToken(
        "clinic-api",
        deps(token, oidc, () => now),
      ),
    ).resolves.toBe(token);
  });
});

describe("a hung mint", () => {
  const hungFetch = ((_url: string, init?: RequestInit) =>
    new Promise<Response>((_ok, fail) => {
      // never answers; like a real fetch it stops when its signal aborts
      init?.signal?.addEventListener("abort", () => fail(new Error("aborted")));
    })) as unknown as typeof fetch;

  it("is cut off, taken out of the in-flight map, and the next call mints afresh and succeeds", async () => {
    const now = 1_000_000;
    const token = jwtWithExp(now / 1000 + 3600);
    const oidc = vi.fn(async () => "VERCEL_OIDC");
    const hung: MintDeps = {
      oidcToken: oidc,
      fetchImpl: hungFetch,
      now: () => now,
      timeoutMs: 40,
    };
    await expect(mintIdToken("clinic-api", hung)).rejects.toThrow(/timed out/);
    expect(oidc).toHaveBeenCalledTimes(1);

    // Straight afterwards, with a working exchange: a FRESH mint, not the hung promise.
    const good = { ...deps(token, oidc, () => now), timeoutMs: 40 };
    const began = Date.now();
    await expect(mintIdToken("clinic-api", good)).resolves.toBe(token);
    expect(Date.now() - began).toBeLessThan(30); // it did not wait on the hung one
    expect(oidc).toHaveBeenCalledTimes(2);
  });

  it("aborts the requests it made, both the exchange and the token", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const seen = ((url: string, init?: RequestInit) => {
      signals.push(init?.signal ?? undefined);
      if (url.includes("sts.googleapis.com"))
        return Promise.resolve(
          new Response(JSON.stringify({ access_token: "STS" }), {
            status: 200,
          }),
        );
      return hungFetch(url, init); // generateIdToken hangs
    }) as unknown as typeof fetch;
    const d: MintDeps = {
      oidcToken: async () => "VERCEL_OIDC",
      fetchImpl: seen,
      now: () => 1_000_000,
      timeoutMs: 40,
    };
    await expect(mintIdToken("clinic-api", d)).rejects.toThrow();
    expect(signals).toHaveLength(2);
    expect(signals.every((s) => s instanceof AbortSignal)).toBe(true);
  });

  it("bounds a Vercel OIDC token that never arrives", async () => {
    const d: MintDeps = {
      oidcToken: () => new Promise<string>(() => undefined),
      fetchImpl: hungFetch,
      now: () => 1_000_000,
      timeoutMs: 40,
    };
    await expect(mintIdToken("clinic-api", d)).rejects.toThrow();
  });
});
