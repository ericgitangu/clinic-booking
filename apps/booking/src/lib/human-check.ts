import { DEFAULT_MIN_SCORE, verifyRecaptcha } from "@clinic/api/recaptcha";
import { logError } from "@clinic/api/proxy/log";

export type Action = "book" | "cancel" | "reschedule";

// Production always checks. Elsewhere (previews cannot reach Google as our identity, local
// development has no credentials) RECAPTCHA_ENFORCE=false turns the check off.
export function enforced(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.VERCEL_ENV === "production") return true;
  return env.RECAPTCHA_ENFORCE !== "false";
}

export type HumanCheck = { ok: true } | { ok: false; unavailable: boolean };

export async function checkHuman(
  token: string | null | undefined,
  action: Action,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HumanCheck> {
  if (!enforced(env)) return { ok: true };
  const siteKey = env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY;
  const serviceAccount = env.RECAPTCHA_SERVICE_ACCOUNT_EMAIL;
  if (!siteKey || !serviceAccount) {
    logError("recaptcha not configured", { action });
    return { ok: false, unavailable: true };
  }
  const minScore = Number(env.RECAPTCHA_MIN_SCORE);
  const result = await verifyRecaptcha({
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
