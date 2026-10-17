// The server-side call to the clinic API, for server components and server actions. It does what
// the /api proxy does for the browser: mint a Cloud Run ID token on Vercel, send it in
// x-serverless-authorization, and nothing else from the caller. Locally (no VERCEL_ENV) the
// request goes to API_URL as it is.
import type { z } from "zod";
import { mintIdToken, minting_enabled } from "./proxy/gcp-id-token";
import { logError } from "./proxy/log";

export type ApiFailure = {
  ok: false;
  status: number;
  code: string;
  detail: string;
};
export type ApiSuccess<T> = { ok: true; status: number; data: T };
export type ApiResult<T> = ApiSuccess<T> | ApiFailure;

export interface CallOptions<S extends z.ZodType> {
  method?: "GET" | "POST" | "PATCH";
  body?: unknown;
  schema: S;
  // Seconds Next may reuse a GET response; omit for always fresh.
  revalidate?: number;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

function failure(status: number, code: string, detail: string): ApiFailure {
  return { ok: false, status, code, detail };
}

export async function callApi<S extends z.ZodType>(
  path: string,
  opts: CallOptions<S>,
): Promise<ApiResult<z.infer<S>>> {
  const base = (process.env.API_URL ?? "").replace(/\/+$/, "");
  if (!base) return failure(503, "API_NOT_CONFIGURED", "API_URL is not set");

  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (minting_enabled()) {
    try {
      const token = await mintIdToken(process.env.API_AUDIENCE ?? "clinic-api");
      headers["x-serverless-authorization"] = `Bearer ${token}`;
    } catch (err) {
      logError("api call: upstream auth failed", {
        detail: String(err).slice(0, 200),
      });
      return failure(502, "UPSTREAM_AUTH_FAILED", "Could not authenticate");
    }
  }

  let resp: Response;
  try {
    resp = await fetch(`${base}${path}`, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      ...(opts.revalidate !== undefined && (opts.method ?? "GET") === "GET"
        ? { next: { revalidate: opts.revalidate } }
        : { cache: "no-store" as const }),
    });
  } catch (err) {
    logError("api call: request failed", {
      path,
      detail: String(err).slice(0, 200),
    });
    return failure(
      503,
      "UPSTREAM_UNREACHABLE",
      "The booking service did not answer",
    );
  }

  let json: unknown = null;
  try {
    json = await resp.json();
  } catch {
    // an empty or non-JSON body is handled below
  }

  if (!resp.ok) {
    const p = (json ?? {}) as { code?: unknown; detail?: unknown };
    return failure(
      resp.status,
      typeof p.code === "string" ? p.code : "UNKNOWN",
      typeof p.detail === "string" ? p.detail : "",
    );
  }
  const parsed = opts.schema.safeParse(json);
  if (!parsed.success) {
    logError("api call: response did not match the contract", {
      path,
      detail: parsed.error.issues[0]?.path.join(".") ?? "",
    });
    return failure(
      502,
      "CONTRACT_MISMATCH",
      "Unexpected response from the booking service",
    );
  }
  return { ok: true, status: resp.status, data: parsed.data };
}
