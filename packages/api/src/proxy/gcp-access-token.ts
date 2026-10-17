// Short-lived access token for a service account the Vercel identity may impersonate, used for
// Google APIs that take an OAuth token (reCAPTCHA Enterprise assessments). Same federation as the
// ID token for Cloud Run; the token is cached until 5 minutes before it expires.
import {
  TokenMintError,
  defaultDeps,
  failure,
  federate,
  requireEnv,
  type MintDeps,
} from "./gcp-id-token";

const REFRESH_SKEW_MS = 5 * 60 * 1000;

interface Cached {
  token: string;
  expMs: number;
}
const cache = new Map<string, Cached>();
const inflight = new Map<string, Promise<string>>();

async function mint(serviceAccount: string, deps: MintDeps): Promise<string> {
  const projectNumber = requireEnv("GCP_PROJECT_NUMBER");
  const federated = await federate(projectNumber, deps);
  const resp = await deps.fetchImpl(
    `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${serviceAccount}:generateAccessToken`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${federated}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        scope: ["https://www.googleapis.com/auth/cloud-platform"],
      }),
    },
  );
  if (!resp.ok) throw await failure("generateAccessToken", resp);
  const { accessToken, expireTime } = (await resp.json()) as {
    accessToken?: string;
    expireTime?: string;
  };
  if (!accessToken) {
    throw new TokenMintError(
      "generateAccessToken",
      resp.status,
      "response had no accessToken",
    );
  }
  const expMs = expireTime ? Date.parse(expireTime) : deps.now() + 55 * 60_000;
  cache.set(serviceAccount, { token: accessToken, expMs });
  return accessToken;
}

export async function mintAccessToken(
  serviceAccount: string,
  deps: MintDeps = defaultDeps,
): Promise<string> {
  const cached = cache.get(serviceAccount);
  if (cached && cached.expMs - REFRESH_SKEW_MS > deps.now()) {
    return cached.token;
  }
  const pending = inflight.get(serviceAccount);
  if (pending) return pending;
  const promise = mint(serviceAccount, deps).finally(() =>
    inflight.delete(serviceAccount),
  );
  inflight.set(serviceAccount, promise);
  return promise;
}

export function _clearAccessCacheForTests(): void {
  cache.clear();
  inflight.clear();
}
