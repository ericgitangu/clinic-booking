import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The stream route itself: who is refused, and that a refusal happens before anything reaches the
// gateway. The session is the one thing replaced (it needs a signed-in browser); fetch is a spy that
// must never be called for a refused request.
const getStaff = vi.fn();
vi.mock("@/lib/session", () => ({ getStaff: () => getStaff() }));

const fetchSpy = vi.fn(async () => new Response("unexpected", { status: 500 }));
const ID = "0f1d2c3b-4a5e-6f70-8192-a3b4c5d6e7f8";

async function call(path = "/live/stream") {
  const { GET } = await import("@/app/live/stream/route");
  return GET(new Request(`http://localhost:3101${path}`));
}

describe("GET /live/stream refusals", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubEnv("REALTIME_URL", "http://127.0.0.1:8090");
    vi.stubEnv("INTERNAL_SIGNING_KEY", "k".repeat(40));
    getStaff.mockReset();
    fetchSpy.mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("nobody signed in is 401, and the gateway is never called", async () => {
    getStaff.mockResolvedValue(null);
    const res = await call();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ status: 401, code: "UNAUTHENTICATED" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("signed in without a staff role is 403, and the gateway is never called", async () => {
    getStaff.mockResolvedValue({
      sub: "g-1",
      email: "someone@clinic.example",
      role: null,
    });
    const res = await call(`/live/stream?appointment=${ID}`);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ status: 403, code: "FORBIDDEN" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a malformed appointment filter is 400 before the gateway is called", async () => {
    getStaff.mockResolvedValue({
      sub: "g-2",
      email: "viewer@clinic.example",
      role: "viewer",
    });
    const res = await call(`/live/stream?appointment=${ID.toUpperCase()}`);
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("Cloud Run's 'no available instance' 500 reaches the page as 503 with Retry-After", async () => {
    getStaff.mockResolvedValue({
      sub: "g-4",
      email: "owner@clinic.example",
      role: "owner",
    });
    fetchSpy.mockResolvedValueOnce(
      new Response(
        "The request was aborted because there was no available instance.",
        { status: 500, headers: { "content-type": "text/html" } },
      ),
    );
    const res = await call();
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("30");
    expect(await res.json()).toEqual({ status: 503, code: "REALTIME_BUSY" });
  });

  it("the gateway's own 429 stays 429 with its Retry-After", async () => {
    getStaff.mockResolvedValue({
      sub: "g-5",
      email: "owner@clinic.example",
      role: "owner",
    });
    fetchSpy.mockResolvedValueOnce(
      new Response('{"code":"RATE_LIMITED"}', {
        status: 429,
        headers: { "retry-after": "30" },
      }),
    );
    const res = await call();
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
  });

  it("a staff member is passed through to the gateway (the control for the cases above)", async () => {
    getStaff.mockResolvedValue({
      sub: "g-3",
      email: "viewer@clinic.example",
      role: "viewer",
    });
    fetchSpy.mockResolvedValueOnce(
      new Response(new ReadableStream<Uint8Array>(), { status: 200 }),
    );
    const res = await call(`/live/stream?appointment=${ID}`);
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url] = fetchSpy.mock.calls[0] as unknown as [string];
    expect(url).toBe(`http://127.0.0.1:8090/stream?appointment=${ID}`);
  });
});
