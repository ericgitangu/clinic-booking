// Mints a Google ID token for a Cloud Run audience by exchanging Vercel's OIDC token
// (STS token-exchange -> IAM generateIdToken). The ID token is cached per audience until
// 5 minutes before its exp, and concurrent cold requests share one in-flight mint. The Vercel
// OIDC token and the STS token are never cached or logged.
// Locally (VERCEL_ENV unset) no token is minted and requests go to the upstream as given.
import { getVercelOidcToken } from "@vercel/oidc";
import { redact } from "./log";

const REFRESH_SKEW_MS = 5 * 60 * 1000;

export type MintStage = "config" | "oidc" | "sts" | "generateIdToken";

// Carries only the failing stage, an HTTP status and a short redacted detail: enough to tell
// "the principal is wrong" from "the role is wrong" from "an env var is missing" in the logs.
export class TokenMintError extends Error {
  constructor(
    readonly stage: MintStage,
    readonly status: number | undefined,
    readonly detail: string,
  ) {
    super(
      `token mint failed at ${stage}${status ? ` (${status})` : ""}: ${detail}`,
    );
  }
}

interface Cached {
  token: string;
  expMs: number;
}
const cache = new Map<string, Cached>();
const inflight = new Map<string, Promise<string>>();

export function minting_enabled(): boolean {
  // In Cloud Run (Vercel production) VERCEL_ENV is set; unset locally.
  return Boolean(process.env.VERCEL_ENV);
}

function decodeExpMs(jwt: string): number {
  const payload = jwt.split(".")[1];
  if (!payload) return 0;
  const json = Buffer.from(payload, "base64url").toString("utf8");
  const exp = (JSON.parse(json) as { exp?: number }).exp;
  return typeof exp === "number" ? exp * 1000 : 0;
}

export interface MintDeps {
  oidcToken: () => Promise<string>;
  fetchImpl: typeof fetch;
  now: () => number;
}

const defaultDeps: MintDeps = {
  oidcToken: getVercelOidcToken,
  fetchImpl: (...args) => fetch(...args),
  now: () => Date.now(),
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new TokenMintError("config", undefined, `${name} is not set`);
  return value;
}

async function failure(
  stage: MintStage,
  resp: Response,
): Promise<TokenMintError> {
  let detail = "";
  try {
    detail = redact(await resp.text());
  } catch {
    // an unreadable body just leaves the detail empty
  }
  return new TokenMintError(stage, resp.status, detail);
}

async function mint(audience: string, deps: MintDeps): Promise<string> {
  // Validate configuration first: a missing value would otherwise become a malformed STS
  // audience or a ":generateIdToken" URL and fail with a confusing remote error.
  const projectNumber = requireEnv("GCP_PROJECT_NUMBER");
  const serviceAccount = requireEnv("GCP_SERVICE_ACCOUNT_EMAIL");
  const pool = process.env.GCP_WORKLOAD_IDENTITY_POOL_ID || "vercel";
  const provider =
    process.env.GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID || "vercel";

  let subject: string;
  try {
    subject = await deps.oidcToken();
  } catch (err) {
    throw new TokenMintError(
      "oidc",
      undefined,
      redact(String(err instanceof Error ? err.message : err)),
    );
  }

  const stsResp = await deps.fetchImpl("https://sts.googleapis.com/v1/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      audience: `//iam.googleapis.com/projects/${projectNumber}/locations/global/workloadIdentityPools/${pool}/providers/${provider}`,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
      subject_token: subject,
    }),
  });
  if (!stsResp.ok) throw await failure("sts", stsResp);
  const { access_token: accessToken } = (await stsResp.json()) as {
    access_token: string;
  };

  const idResp = await deps.fetchImpl(
    `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${serviceAccount}:generateIdToken`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ audience, includeEmail: true }),
    },
  );
  if (!idResp.ok) throw await failure("generateIdToken", idResp);
  const { token } = (await idResp.json()) as { token: string };

  cache.set(audience, { token, expMs: decodeExpMs(token) });
  return token;
}

export async function mintIdToken(
  audience: string,
  deps: MintDeps = defaultDeps,
): Promise<string> {
  const cached = cache.get(audience);
  if (cached && cached.expMs - REFRESH_SKEW_MS > deps.now()) {
    return cached.token;
  }
  const pending = inflight.get(audience);
  if (pending) return pending;

  const promise = mint(audience, deps).finally(() => inflight.delete(audience));
  inflight.set(audience, promise);
  return promise;
}

export function _clearCacheForTests(): void {
  cache.clear();
  inflight.clear();
}
