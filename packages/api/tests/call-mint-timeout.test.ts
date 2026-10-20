import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The Cloud Run identity token is fetched before the request is sent, so the request's own timeout
// does not cover it: a hung exchange with Google would hold every call. It is cut off at
// MINT_TIMEOUT_MS and the call fails as an upstream auth failure, without sending anything.
vi.mock("../src/proxy/gcp-id-token", () => ({
  minting_enabled: () => true,
  mintIdToken: () => new Promise<string>(() => undefined), // never answers
}));

import { MINT_TIMEOUT_MS, callApi } from "../src/call";
import { getMetricsInternalAdminMetricsGet } from "../src/generated";

beforeEach(() => {
  vi.useFakeTimers();
  process.env.API_URL = "https://api.example.run.app";
  process.env.INTERNAL_SIGNING_KEY = "k".repeat(32);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("callApi and the identity token exchange", () => {
  it("gives up on a hung exchange after MINT_TIMEOUT_MS and sends nothing", async () => {
    const sent = vi.spyOn(globalThis, "fetch");
    const pending = callApi(
      "metrics",
      (client) =>
        getMetricsInternalAdminMetricsGet({
          client,
          query: { from: "2026-10-01", to: "2026-10-08", bucket: "day" },
        }),
      { caller: { sub: "s", email: "a@clinic.example", role: "owner" } },
    );
    let settled = false;
    void pending.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(MINT_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    const res = await pending;
    expect(res).toMatchObject({ ok: false, code: "UPSTREAM_AUTH_FAILED" });
    expect(sent).not.toHaveBeenCalled();
  });

  it("is 5 s", () => {
    expect(MINT_TIMEOUT_MS).toBe(5000);
  });
});
