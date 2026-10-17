// The vercel.app alias redirect against the real production build, sent over real HTTP with a Host
// header (the unit tests cover the matching rules; this proves the built app does it).
import { expect, test } from "@playwright/test";

const CANONICAL = "https://clinic-admin.ericgitangu.com";
const get = (
  request: import("@playwright/test").APIRequestContext,
  host: string,
  path: string,
) => request.get(path, { headers: { host }, maxRedirects: 0 });

test("an alias host gets a 308 to the custom domain, path and query kept", async ({
  request,
}) => {
  for (const host of [
    "clinic-admin-azure.vercel.app",
    "clinic-admin-eric-gitangus-projects.vercel.app",
  ]) {
    const res = await get(request, host, "/dashboard/appointments/abc?days=30");
    expect(res.status(), host).toBe(308);
    expect(res.headers().location).toBe(
      `${CANONICAL}/dashboard/appointments/abc?days=30`,
    );
  }
});

test("a deployment URL, the custom domain and localhost keep serving", async ({
  request,
}) => {
  for (const host of [
    "clinic-admin-k3j9x2abc-eric-gitangus-projects.vercel.app",
    "clinic-admin.ericgitangu.com",
    "localhost:3101",
  ]) {
    const res = await get(request, host, "/dashboard");
    // Signed out: the page itself sends the person to sign-in, on the same host.
    expect(res.status(), host).not.toBe(308);
    expect(res.headers().location ?? "").not.toContain(
      "ericgitangu.com/dashboard",
    );
  }
});

test("sign-in routes on an alias are left alone", async ({ request }) => {
  const res = await get(
    request,
    "clinic-admin-azure.vercel.app",
    "/auth/get-session",
  );
  expect(res.status()).toBe(200);
});
