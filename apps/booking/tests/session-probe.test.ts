import { afterEach, describe, expect, it, vi } from "vitest";
import { hasSession } from "@/components/account/session-menu";

const reply = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

afterEach(() => vi.unstubAllGlobals());

describe("hasSession", () => {
  it("is true when the server returns a session, and asks the auth endpoint without caching", async () => {
    const fetch = reply(200, { session: { id: "s1" }, user: { id: "u1" } });
    vi.stubGlobal("fetch", fetch);
    await expect(hasSession()).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      "/auth/get-session",
      expect.objectContaining({
        cache: "no-store",
        credentials: "same-origin",
      }),
    );
  });

  it.each([
    ["signed out (Better Auth answers null)", 200, null],
    ["a body without a session", 200, { user: null }],
    ["sign-in not configured (503)", 503, { title: "unavailable" }],
  ])("is false when %s", async (_name, status, body) => {
    vi.stubGlobal("fetch", reply(status, body));
    await expect(hasSession()).resolves.toBe(false);
  });

  it("is false, not a rejection, when the request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network down");
      }),
    );
    await expect(hasSession()).resolves.toBe(false);
  });
});
