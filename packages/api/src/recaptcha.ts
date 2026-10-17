// reCAPTCHA Enterprise verification, server side. The browser sends the token its execute() call
// produced for one named action; here an assessment is created and four things are checked: the
// token is present, Google says it is valid, it was issued for the action this server expects, and
// the risk score is at least the minimum. Any failure to reach Google fails closed.
import { mintAccessToken } from "./proxy/gcp-access-token";
import { redact } from "./proxy/log";

export const DEFAULT_MIN_SCORE = 0.5;

export type RecaptchaFailure =
  | "missing-token"
  | "invalid-token"
  | "wrong-action"
  | "low-score"
  | "unavailable";

export type RecaptchaResult =
  | { ok: true; score: number }
  | { ok: false; reason: RecaptchaFailure; detail?: string };

export interface RecaptchaDeps {
  accessToken: (serviceAccount: string) => Promise<string>;
  fetchImpl: typeof fetch;
}

const defaultDeps: RecaptchaDeps = {
  accessToken: (sa) => mintAccessToken(sa),
  fetchImpl: (...args) => fetch(...args),
};

export interface VerifyInput {
  token: string | null | undefined;
  expectedAction: string;
  siteKey: string;
  // clinic-recaptcha@<project>.iam.gserviceaccount.com; the project id is taken from it.
  serviceAccount: string;
  minScore?: number;
}

interface Assessment {
  tokenProperties?: {
    valid?: boolean;
    invalidReason?: string;
    action?: string;
  };
  riskAnalysis?: { score?: number };
}

function projectOf(serviceAccount: string): string | null {
  const m =
    /^[^@]+@([a-z][a-z0-9-]{4,28}[a-z0-9])\.iam\.gserviceaccount\.com$/.exec(
      serviceAccount,
    );
  return m ? m[1] : null;
}

export async function verifyRecaptcha(
  input: VerifyInput,
  deps: RecaptchaDeps = defaultDeps,
): Promise<RecaptchaResult> {
  if (!input.token) return { ok: false, reason: "missing-token" };
  const project = projectOf(input.serviceAccount);
  if (!project) {
    return { ok: false, reason: "unavailable", detail: "bad service account" };
  }
  let assessment: Assessment;
  try {
    const bearer = await deps.accessToken(input.serviceAccount);
    const resp = await deps.fetchImpl(
      `https://recaptchaenterprise.googleapis.com/v1/projects/${project}/assessments`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${bearer}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          event: {
            token: input.token,
            siteKey: input.siteKey,
            expectedAction: input.expectedAction,
          },
        }),
      },
    );
    if (!resp.ok) {
      return {
        ok: false,
        reason: "unavailable",
        detail: `assessment ${resp.status} ${redact((await resp.text()).slice(0, 200))}`,
      };
    }
    assessment = (await resp.json()) as Assessment;
  } catch (err) {
    return {
      ok: false,
      reason: "unavailable",
      detail: redact(String(err instanceof Error ? err.message : err)),
    };
  }

  const props = assessment.tokenProperties;
  if (!props?.valid) {
    return { ok: false, reason: "invalid-token", detail: props?.invalidReason };
  }
  if (props.action !== input.expectedAction) {
    return { ok: false, reason: "wrong-action", detail: props.action };
  }
  const score = assessment.riskAnalysis?.score;
  if (typeof score !== "number") {
    return { ok: false, reason: "unavailable", detail: "no score returned" };
  }
  if (score < (input.minScore ?? DEFAULT_MIN_SCORE)) {
    return { ok: false, reason: "low-score", detail: String(score) };
  }
  return { ok: true, score };
}
