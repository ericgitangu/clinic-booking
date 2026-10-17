import { describe, expect, it } from "vitest";
import { forward } from "../src/proxy/forward";

function fetchReturning(resp: Response): typeof fetch {
  return (async () => resp) as unknown as typeof fetch;
}

describe("Location rewrite", () => {
  it("rewrites a root-relative Location to /api + value", async () => {
    const res = await forward(
      new Request("https://web.example/api/appointments", { method: "POST" }),
      {
        baseUrl: "https://api.example.run.app",
        upstreamPath: "/appointments",
        fetchImpl: fetchReturning(
          new Response(null, {
            status: 201,
            headers: { location: "/appointments/abc" },
          }),
        ),
      },
    );
    expect(res.headers.get("location")).toBe("/api/appointments/abc");
  });

  it("leaves an absolute Location alone", async () => {
    const res = await forward(new Request("https://web.example/api/x"), {
      baseUrl: "https://api.example.run.app",
      upstreamPath: "/x",
      fetchImpl: fetchReturning(
        new Response(null, {
          status: 302,
          headers: { location: "https://elsewhere/x" },
        }),
      ),
    });
    expect(res.headers.get("location")).toBe("https://elsewhere/x");
  });
});
