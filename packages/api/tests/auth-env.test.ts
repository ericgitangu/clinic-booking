import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  authEnvSchema,
  logNotConfiguredOnce,
  notConfiguredResponse,
  readAuthEnv,
  resetNotConfiguredLog,
} from "../src/auth-env";

const FULL = {
  BETTER_AUTH_URL: "https://admin.example.test",
  BETTER_AUTH_SECRET: "s".repeat(32),
  GOOGLE_CLIENT_ID: "id",
  GOOGLE_CLIENT_SECRET: "secret",
};

describe("readAuthEnv", () => {
  it("accepts a complete environment", () => {
    expect(readAuthEnv(FULL)).toEqual({ ok: true, env: FULL });
  });

  it("names every missing variable and nothing else", () => {
    expect(readAuthEnv({})).toEqual({
      ok: false,
      missing: [
        "BETTER_AUTH_URL",
        "BETTER_AUTH_SECRET",
        "GOOGLE_CLIENT_ID",
        "GOOGLE_CLIENT_SECRET",
      ],
    });
  });

  it("treats blank and whitespace values as missing", () => {
    const r = readAuthEnv({
      ...FULL,
      GOOGLE_CLIENT_ID: "  ",
      BETTER_AUTH_SECRET: "",
    });
    expect(r).toEqual({
      ok: false,
      missing: ["BETTER_AUTH_SECRET", "GOOGLE_CLIENT_ID"],
    });
  });

  it("rejects a base URL that is not a URL, without echoing it", () => {
    const r = readAuthEnv({ ...FULL, BETTER_AUTH_URL: "not-a-url-9f3" });
    expect(r).toEqual({ ok: false, missing: ["BETTER_AUTH_URL"] });
    expect(JSON.stringify(r)).not.toContain("9f3");
  });
});

describe("notConfiguredResponse", () => {
  it("is a 503 page that is not cached and says what to do", async () => {
    const res = notConfiguredResponse("Idyllic Clinic Admin");
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("retry-after")).toBe("300");
    const body = await res.text();
    expect(body).toContain("Sign-in is not configured");
    expect(body).toContain("Idyllic Clinic Admin");
  });
});

describe("logNotConfiguredOnce", () => {
  beforeEach(() => resetNotConfiguredLog());

  it("writes one structured line per instance, names only", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logNotConfiguredOnce("admin", ["BETTER_AUTH_URL"]);
    logNotConfiguredOnce("admin", ["BETTER_AUTH_URL"]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(spy.mock.calls[0]![0]))).toEqual({
      level: "error",
      event: "auth_not_configured",
      app: "admin",
      missing: ["BETTER_AUTH_URL"],
    });
    spy.mockRestore();
  });
});

describe("scripts/ci/required_env.txt", () => {
  it("lists every sign-in variable for both apps, so the pre-ship check cannot drift from the schema", () => {
    const file = readFileSync(
      new URL("../../../scripts/ci/required_env.txt", import.meta.url),
      "utf8",
    );
    const rows = file
      .split("\n")
      .filter((l) => l.trim() && !l.startsWith("#"))
      .map((l) => l.trim().split(/\s+/) as [string, string]);
    for (const app of ["booking", "admin"]) {
      const names = rows.filter(([a]) => a === app).map(([, n]) => n);
      for (const key of Object.keys(authEnvSchema.shape)) {
        expect(names, `${app} lists ${key}`).toContain(key);
      }
    }
  });
});
