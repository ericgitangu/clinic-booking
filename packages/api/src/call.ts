// The server-side call to the clinic API, for server components and server actions.
//
// Every call goes through the generated SDK, so the request is checked against the generated zod
// schema before anything is sent, and a successful response against the schema for that operation.
// A problem+json error body is checked against the generated Problem schema and its `code` is one
// of the generated ProblemCode values. Anything that does not match is contract drift: it is logged
// as a structured `contract_violation` event (operation, status and the paths of the zod issues,
// never a value) and surfaced as a generic failure. Each call parses its body once.
import { ZodError } from "zod";
import { ASSERTION_HEADER, signAssertion } from "./assertion";
import { createClient, createConfig, type Client } from "./generated/client";
import type { ProblemCode } from "./generated/types.gen";
import {
  zCreateAppointmentAppointmentsPostHeaders,
  zProblem,
} from "./generated/zod.gen";
import { mintIdToken, minting_enabled } from "./proxy/gcp-id-token";
import { logError } from "./proxy/log";

export type { ProblemCode } from "./generated/types.gen";

// A field that failed request validation, by name and zod issue code (never the value).
export type FieldIssue = { field: string; code: string };

export type ApiFailureCode =
  | ProblemCode
  | "CONTRACT_VIOLATION"
  | "UPSTREAM_AUTH_FAILED"
  | "UPSTREAM_UNREACHABLE"
  | "API_NOT_CONFIGURED"
  | "SIGNING_KEY_NOT_SET";

export type ApiFailure =
  | {
      ok: false;
      kind: "problem";
      status: number;
      code: ProblemCode;
      detail: string;
      /** Whole seconds from a Retry-After header (429), when the API sent one. */
      retryAfter?: number;
    }
  // 422-style: the request did not match the generated schema, so nothing was sent.
  | {
      ok: false;
      kind: "invalid_request";
      status: 422;
      code: "VALIDATION_ERROR";
      issues: FieldIssue[];
    }
  | {
      ok: false;
      kind: "contract_violation";
      status: 502;
      code: "CONTRACT_VIOLATION";
    }
  | { ok: false; kind: "unavailable"; status: number; code: ApiFailureCode };

export type ApiSuccess<T> = { ok: true; status: number; data: T };
export type ApiResult<T> = ApiSuccess<T> | ApiFailure;

// Who is calling /internal/*, for the signed assertion (see assertion.ts). The key is read from
// INTERNAL_SIGNING_KEY. Omit for the public endpoints, which take no assertion.
export interface Caller {
  sub: string;
  email: string;
  /** The role the API should see; "none" only when asking what role an email holds. */
  role: string;
  /** Whether the sign-in provider verified the email; the patient routes refuse it when not true. */
  emailVerified?: boolean;
}

export interface CallOptions {
  // Seconds Next may reuse a GET response; omit for always fresh.
  revalidate?: number;
  timeoutMs?: number;
  caller?: Caller;
}

export const DEFAULT_TIMEOUT_MS = 15_000;

// What a generated SDK function resolves to, whichever branch it took.
type SdkOutcome<D> = {
  data?: D;
  error?: unknown;
  request?: Request;
  response?: Response;
};

class UpstreamAuthError extends Error {}

function issuePaths(err: ZodError): string {
  return err.issues
    .slice(0, 10)
    .map((i) => i.path.join(".") || "(root)")
    .join(",");
}

function violation(
  operation: string,
  status: number | undefined,
  where: string,
  err?: ZodError,
): ApiFailure {
  logError("contract_violation", {
    operation,
    status,
    where,
    paths: err ? issuePaths(err) : undefined,
  });
  return {
    ok: false,
    kind: "contract_violation",
    status: 502,
    code: "CONTRACT_VIOLATION",
  };
}

function unavailable(status: number, code: ApiFailureCode): ApiFailure {
  return { ok: false, kind: "unavailable", status, code };
}

export async function callApi<D>(
  operation: string,
  run: (client: Client) => Promise<SdkOutcome<D>>,
  opts: CallOptions = {},
): Promise<ApiResult<D>> {
  const baseUrl = (process.env.API_URL ?? "").replace(/\/+$/, "");
  if (!baseUrl) return unavailable(503, "API_NOT_CONFIGURED");

  const signingKey = process.env.INTERNAL_SIGNING_KEY;
  if (opts.caller && !signingKey)
    return unavailable(503, "SIGNING_KEY_NOT_SET");

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const client = createClient(
    createConfig({
      baseUrl,
      throwOnError: false,
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = new Request(input, init);
        // The generated SDK builds an optional header schema but runs it against a Headers
        // object, where it can never fail, so a malformed Idempotency-Key would reach the API.
        // Check it here with the generated schema (both booking POSTs share the same rule); the
        // ZodError surfaces as an invalid_request, before anything is signed or sent.
        zCreateAppointmentAppointmentsPostHeaders.parse({
          "Idempotency-Key": req.headers.get("idempotency-key") ?? undefined,
        });
        if (opts.caller && signingKey) {
          // Signed over the request as it is about to be sent: method, path with query, body.
          const url = new URL(req.url);
          req.headers.set(
            ASSERTION_HEADER,
            signAssertion(
              {
                ...opts.caller,
                method: req.method,
                path: url.pathname + url.search,
                body: await req.clone().text(),
                now: new Date(),
              },
              signingKey,
            ),
          );
        }
        if (minting_enabled()) {
          try {
            const token = await mintIdToken(
              process.env.API_AUDIENCE ?? "clinic-api",
            );
            req.headers.set("x-serverless-authorization", `Bearer ${token}`);
          } catch (err) {
            logError("api call: upstream auth failed", {
              operation,
              detail: String(err).slice(0, 200),
            });
            throw new UpstreamAuthError();
          }
        }
        const cacheable = opts.revalidate !== undefined && req.method === "GET";
        return fetch(req, {
          signal: AbortSignal.timeout(timeoutMs),
          ...(cacheable
            ? { next: { revalidate: opts.revalidate } }
            : { cache: "no-store" as const }),
        });
      },
    }),
  );

  const out = await run(client);

  if (out.error === undefined) {
    if (out.data === undefined)
      return violation(operation, out.response?.status, "empty response");
    return { ok: true, status: out.response?.status ?? 200, data: out.data };
  }

  const { error, response } = out;
  if (error instanceof ZodError) {
    // No response yet: the request validator refused to send it.
    if (!response) {
      const issues = error.issues.map((i) => ({
        // issue paths start with the part of the request ("body", "path", "query")
        field: String(i.path[1] ?? i.path[0] ?? "request"),
        code: i.code,
      }));
      return {
        ok: false,
        kind: "invalid_request",
        status: 422,
        code: "VALIDATION_ERROR",
        issues,
      };
    }
    return violation(operation, response.status, "response", error);
  }
  if (error instanceof UpstreamAuthError)
    return unavailable(502, "UPSTREAM_AUTH_FAILED");
  if (!response) return unavailable(503, "UPSTREAM_UNREACHABLE");

  // An error status: the body must be a problem+json that matches the generated schema.
  const problem = zProblem.safeParse(error);
  if (!problem.success)
    return violation(operation, response.status, "problem", problem.error);
  const wait = Number(response.headers.get("retry-after"));
  return {
    ok: false,
    kind: "problem",
    status: response.status,
    code: problem.data.code,
    detail: problem.data.detail,
    ...(Number.isInteger(wait) && wait > 0 ? { retryAfter: wait } : {}),
  };
}

// Checks a request body against a generated schema before any call, so a form can show field
// errors without a round trip and without creating anything on the way. Same issue shape as callApi.
export function checkRequest(
  schema: { safeParse: (v: unknown) => { success: boolean; error?: ZodError } },
  value: unknown,
): FieldIssue[] {
  const r = schema.safeParse(value);
  if (r.success || !r.error) return [];
  return r.error.issues.map((i) => ({
    field: String(i.path[0] ?? "request"),
    code: i.code,
  }));
}
