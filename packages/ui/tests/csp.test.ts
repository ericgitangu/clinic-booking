import { describe, expect, it } from "vitest";
import { ABLY_HOSTS, buildCsp } from "@clinic/ui/lib/csp";

const dir = (csp: string, name: string) =>
  csp
    .split("; ")
    .find((d) => d.startsWith(`${name} `))
    ?.slice(name.length + 1);

describe("buildCsp", () => {
  const csp = buildCsp({
    script: ["https://www.google.com"],
    connect: ABLY_HOSTS,
    img: ["https://lh3.googleusercontent.com"],
  });

  it("closes the doors that have no business being open", () => {
    expect(dir(csp, "default-src")).toBe("'self'");
    expect(dir(csp, "object-src")).toBe("'none'");
    expect(dir(csp, "base-uri")).toBe("'self'");
    expect(dir(csp, "frame-ancestors")).toBe("'none'");
    expect(dir(csp, "frame-src")).toBe("'none'");
  });

  it("allows only the hosts it is given, and no wildcard for scripts", () => {
    expect(dir(csp, "script-src")).toBe(
      "'self' 'unsafe-inline' https://www.google.com",
    );
    expect(dir(csp, "img-src")).toContain("https://lh3.googleusercontent.com");
    expect(dir(csp, "connect-src")).toContain("wss://realtime.ably.net");
    // The event stream goes to a two-level host.
    expect(dir(csp, "connect-src")).toContain("https://*.ably.net");
    expect(dir(csp, "script-src")).not.toContain("*");
  });

  it("never allows eval outside development", () => {
    expect(csp).not.toContain("unsafe-eval");
    expect(buildCsp({ dev: true })).toContain("'unsafe-eval'");
  });

  it("names the frame hosts instead of 'none' when there are some", () => {
    expect(
      dir(buildCsp({ frame: ["https://www.google.com"] }), "frame-src"),
    ).toBe("https://www.google.com");
  });
});
