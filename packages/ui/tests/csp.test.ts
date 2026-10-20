import { createHash } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ThemeProvider } from "@clinic/ui/components/layout/theme-provider";
import { THEME_INIT_SCRIPT } from "@clinic/ui/lib/theme-init";
import {
  ABLY_STREAM_ORIGIN,
  SECURITY_HEADERS,
  THEME_SCRIPT_HASH,
  buildCsp,
  newNonce,
} from "@clinic/ui/lib/csp";

const dir = (csp: string, name: string) =>
  csp
    .split("; ")
    .find((d) => d === name || d.startsWith(`${name} `))
    ?.slice(name.length + 1);

describe("buildCsp with a nonce", () => {
  const csp = buildCsp({
    script: { kind: "nonce", nonce: "abc123" },
    connect: [ABLY_STREAM_ORIGIN],
    img: ["https://lh3.googleusercontent.com"],
    frame: ["https://www.google.com"],
  });

  it("allows only nonced and strict-dynamic scripts, and names no host", () => {
    expect(dir(csp, "script-src")).toBe(
      `'nonce-abc123' '${THEME_SCRIPT_HASH}' 'strict-dynamic'`,
    );
    expect(dir(csp, "script-src")).not.toContain("unsafe-inline");
    expect(dir(csp, "script-src")).not.toContain("http");
  });

  it("closes the doors that have no business being open", () => {
    expect(dir(csp, "default-src")).toBe("'self'");
    expect(dir(csp, "object-src")).toBe("'none'");
    expect(dir(csp, "base-uri")).toBe("'self'");
    expect(dir(csp, "frame-ancestors")).toBe("'none'");
    expect(dir(buildCsp({ script: { kind: "inline" } }), "frame-src")).toBe(
      "'none'",
    );
  });

  it("lets the stream reach exactly one push host and nothing else", () => {
    expect(dir(csp, "connect-src")).toBe(
      "'self' https://main.realtime.ably.net",
    );
  });

  it("never allows eval outside development", () => {
    expect(csp).not.toContain("unsafe-eval");
    expect(buildCsp({ script: { kind: "inline" }, dev: true })).toContain(
      "'unsafe-eval'",
    );
  });

  it("asks the browser to upgrade http only when told to, and never in development", () => {
    expect(csp).not.toContain("upgrade-insecure-requests");
    expect(
      dir(
        buildCsp({ script: { kind: "inline" }, upgradeInsecure: true }),
        "upgrade-insecure-requests",
      ),
    ).toBe("");
    expect(
      buildCsp({
        script: { kind: "inline" },
        upgradeInsecure: true,
        dev: true,
      }),
    ).not.toContain("upgrade-insecure-requests");
  });
});

describe("buildCsp for pages built once", () => {
  it("allows 'self' and the page's own hashes, and no inline script", () => {
    const csp = buildCsp({
      script: { kind: "hashes", hashes: ["'sha256-aaa'", "'sha256-bbb'"] },
    });
    expect(dir(csp, "script-src")).toBe("'self' 'sha256-aaa' 'sha256-bbb'");
    expect(csp).not.toContain("unsafe-inline'; style"); // style keeps it, script does not
    expect(dir(csp, "script-src")).not.toContain("unsafe-inline");
  });
  it("keeps 'unsafe-inline' only for next dev", () => {
    expect(dir(buildCsp({ script: { kind: "inline" } }), "script-src")).toBe(
      "'self' 'unsafe-inline'",
    );
  });
});

describe("the theme script", () => {
  it("has the hash the policy names", () => {
    const hash = `sha256-${createHash("sha256").update(THEME_INIT_SCRIPT).digest("base64")}`;
    expect(THEME_SCRIPT_HASH).toBe(hash);
  });

  it("is the one runnable inline script the provider renders; next-themes' own is inert", () => {
    const html = renderToStaticMarkup(createElement(ThemeProvider, null));
    const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
    const runnable = scripts.filter(
      (m) => !/type="application\/json"/.test(m[1]),
    );
    expect(runnable).toHaveLength(1);
    expect(runnable[0][2]).toBe(THEME_INIT_SCRIPT);
  });

  it("sets the dark class for a stored or system dark choice, and keeps light otherwise", () => {
    const run = (stored: string | null, systemDark: boolean) => {
      const classes = new Set<string>();
      const el = {
        classList: {
          remove: (...c: string[]) => c.forEach((x) => classes.delete(x)),
          add: (c: string) => classes.add(c),
        },
        style: {} as Record<string, string>,
      };
      new Function("document", "localStorage", "matchMedia", THEME_INIT_SCRIPT)(
        { documentElement: el },
        { getItem: () => stored },
        () => ({ matches: systemDark }),
      );
      return { classes: [...classes], scheme: el.style.colorScheme };
    };
    expect(run(null, true)).toEqual({ classes: ["dark"], scheme: "dark" });
    expect(run(null, false)).toEqual({ classes: ["light"], scheme: "light" });
    expect(run("system", true).classes).toEqual(["dark"]);
    expect(run("light", true)).toEqual({ classes: ["light"], scheme: "light" });
    expect(run("dark", false)).toEqual({ classes: ["dark"], scheme: "dark" });
  });
});

describe("nonce and headers", () => {
  it("makes a different nonce every time", () => {
    expect(newNonce()).not.toBe(newNonce());
    expect(newNonce().length).toBeGreaterThan(20);
  });
  it("sends nosniff, a referrer policy and a minimal permissions policy", () => {
    const keys = SECURITY_HEADERS.map((h) => h.key);
    expect(keys).toEqual([
      "X-Content-Type-Options",
      "Referrer-Policy",
      "Permissions-Policy",
    ]);
  });
});
