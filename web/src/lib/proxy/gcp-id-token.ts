// Mints a Google ID token for a Cloud Run audience by exchanging Vercel's OIDC token
// (STS token-exchange -> IAM generateIdToken). The ID token is cached per audience until
// 5 minutes before its exp; the Vercel OIDC token and the STS token are never cached.
// Locally (VERCEL_ENV unset) no token is minted and requests go to the upstream as given.
import { getVercelOidcToken } from "@vercel/oidc";

const PROJECT_NUMBER = () => process.env.GCP_PROJECT_NUMBER ?? "";
const SA_EMAIL = () => process.env.GCP_SERVICE_ACCOUNT_EMAIL ?? "";
const POOL = () => process.env.GCP_WORKLOAD_IDENTITY_POOL_ID ?? "vercel";
const PROVIDER = () =>
  process.env.GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID ?? "vercel";

const REFRESH_SKEW_MS = 5 * 60 * 1000;

interface Cached {
  token: string;
  expMs: number;
}
const cache = new Map<string, Cached>();

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

export async function mintIdToken(
  audience: string,
  deps: MintDeps = defaultDeps,
): Promise<string> {
  const cached = cache.get(audience);
  if (cached && cached.expMs - REFRESH_SKEW_MS > deps.now()) {
    return cached.token;
  }

  const subject = await deps.oidcToken();

  const stsResp = await deps.fetchImpl("https://sts.googleapis.com/v1/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      audience: `//iam.googleapis.com/projects/${PROJECT_NUMBER()}/locations/global/workloadIdentityPools/${POOL()}/providers/${PROVIDER()}`,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
      subject_token: subject,
    }),
  });
  if (!stsResp.ok) {
    throw new Error(`STS token exchange failed: ${stsResp.status}`);
  }
  const { access_token: accessToken } = (await stsResp.json()) as {
    access_token: string;
  };

  const idResp = await deps.fetchImpl(
    `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${SA_EMAIL()}:generateIdToken`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ audience, includeEmail: true }),
    },
  );
  if (!idResp.ok) {
    throw new Error(`generateIdToken failed: ${idResp.status}`);
  }
  const { token } = (await idResp.json()) as { token: string };

  cache.set(audience, { token, expMs: decodeExpMs(token) });
  return token;
}

export function _clearCacheForTests(): void {
  cache.clear();
}
