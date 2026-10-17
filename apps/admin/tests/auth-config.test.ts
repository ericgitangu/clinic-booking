import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AUTH_BASE_PATH } from "@/lib/auth-config";

const read = (p: string) =>
  readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

describe("Better Auth base path", () => {
  it("is /auth", () => {
    expect(AUTH_BASE_PATH).toBe("/auth");
  });

  it("is the same constant on the server and in the client", () => {
    expect(read("lib/auth-options.ts")).toMatch(/basePath:\s*AUTH_BASE_PATH/);
    expect(read("lib/auth-client.ts")).toMatch(/basePath:\s*AUTH_BASE_PATH/);
  });

  it("serves the handler from the app/auth route", () => {
    expect(read("app/auth/[...all]/route.ts")).toContain("toNextJsHandler");
  });
});
