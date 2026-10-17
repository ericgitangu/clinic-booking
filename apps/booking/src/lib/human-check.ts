import { DEFAULT_MIN_SCORE, verifyRecaptcha } from "@clinic/api/recaptcha";
import { logError } from "@clinic/api/proxy/log";

export type Action = "book" | "cancel" | "reschedule";

// The check can be switched off only for automated tests: RECAPTCHA_ENFORCE=false together with
// NODE_ENV=test or E2E=1, and never when VERCEL_ENV is production. In every other case it runs, and
// if it cannot run (no keys, no way to reach Google) the request is refused.
export function enforced(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.VERCEL_ENV === "production") return true;
  const testRun = env.NODE_ENV === "test" || env.E2E === "1";
  return !(env.RECAPTCHA_ENFORCE === "false" && testRun);
}

export type HumanCheck = { ok: true } | { ok: false; unavailable: boolean };

export interface HumanDeps {
  env?: NodeJS.ProcessEnv;
  verify?: typeof verifyRecaptcha;
}

export async function checkHuman(
  token: string | null | undefined,
  action: Action,
  deps: HumanDeps = {},
): Promise<HumanCheck> {
  const env = deps.env ?? process.env;
  const verify = deps.verify ?? verifyRecaptcha;
  if (!enforced(env)) return { ok: true };
  const siteKey = env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY;
  const serviceAccount = env.RECAPTCHA_SERVICE_ACCOUNT_EMAIL;
  if (!siteKey || !serviceAccount) {
    logError("recaptcha not configured", { action });
    return { ok: false, unavailable: true };
  }
  const minScore = Number(env.RECAPTCHA_MIN_SCORE);
  const result = await verify({
    token,
    expectedAction: action,
    siteKey,
    serviceAccount,
    minScore:
      Number.isFinite(minScore) && minScore > 0 ? minScore : DEFAULT_MIN_SCORE,
  });
  if (result.ok) return { ok: true };
  logError("recaptcha rejected", {
    action,
    reason: result.reason,
    detail: result.detail,
  });
  return { ok: false, unavailable: result.reason === "unavailable" };
}
