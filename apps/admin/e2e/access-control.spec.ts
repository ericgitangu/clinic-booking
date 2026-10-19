// Who can open what, against the real app, API and database. Each person is signed in with a
// cookie that Better Auth produced and the app decoded; the role comes from the real staff_access
// table through the real API, and the API checks it again on every call.
import { BASE_URL, EMAIL, internal, OWNER, publicApi } from "./support/stack";
import { expect, seeded, test } from "./support/fixtures";

const PAGES = ["/dashboard", "/access"] as const;

// The next values are deliberately fake. They are forged on purpose, they are not credentials and
// not secrets: the tests below send them to the real app and the real API, which must reject them
// (a redirect to sign-in from the app, a 401 from the API). They are built from parts and marked
// with a ggignore comment, because GitGuardian's "Generic High Entropy Secret" detector reads any
// random-looking string as a secret.

// "forged.value" as a session token: not signed by the app, so it must count as no session.
const FORGED_SESSION_TOKEN = ["forged", "value"].join("."); // ggignore

// The base64 of {"forged":true} as the session cache: not encrypted by the app, so it is refused.
const FORGED_SESSION_DATA =
  Buffer.from('{"forged":true}').toString("base64url"); // ggignore

// "v1.<payload>.AAAA" as an assertion: the signature is junk, so the API must answer 401.
const JUNK_PAYLOAD = Buffer.from('{"a":1}').toString("base64url"); // ggignore
const JUNK_ASSERTION = `v1.${JUNK_PAYLOAD}.AAAA`; // ggignore

test.describe("signed out", () => {
  for (const path of ["/dashboard", "/access"]) {
    test(`${path} goes to sign-in`, async ({ page }) => {
      await page.goto(path);
      await expect(page).toHaveURL(/\/$/);
      await expect(
        page.getByRole("button", { name: "Sign in with Google" }),
      ).toBeVisible();
    });
  }

  test("an appointment page goes to sign-in", async ({ page }) => {
    await page.goto(`/dashboard/appointments/${seeded().free[0]}`);
    await expect(page).toHaveURL(/\/$/);
  });

  test("a forged session cookie is not a session", async ({ page }) => {
    await page.context().addCookies([
      {
        name: "better-auth.session_token",
        value: FORGED_SESSION_TOKEN,
        url: BASE_URL,
      },
      {
        name: "better-auth.session_data",
        value: FORGED_SESSION_DATA,
        url: BASE_URL,
      },
    ]);
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/$/);
  });
});

test.describe("page access by role", () => {
  const expected = {
    owner: { "/dashboard": 200, "/access": 200 },
    admin: { "/dashboard": 200, "/access": 403 },
    viewer: { "/dashboard": 200, "/access": 403 },
    revoked: { "/dashboard": 403, "/access": 403 },
    stranger: { "/dashboard": 403, "/access": 403 },
  } as const;

  for (const [who, pages] of Object.entries(expected)) {
    for (const path of PAGES) {
      test(`${who} gets ${pages[path]} on ${path}`, async ({ as }) => {
        const page = await as(who);
        const res = await page.goto(path);
        expect(res?.status()).toBe(pages[path]);
        if (pages[path] === 403) {
          await expect(
            page.getByRole("heading", { name: "You do not have access" }),
          ).toBeVisible();
          await expect(page.getByText("Ask the clinic owner")).toBeVisible();
        }
      });
    }
  }

  test("someone without access also gets a 403 at the sign-in page, not a loop", async ({
    as,
  }) => {
    const page = await as("stranger");
    const res = await page.goto("/");
    expect(res?.status()).toBe(403);
  });

  test("an owner who opens the sign-in page goes on to the dashboard", async ({
    as,
  }) => {
    const page = await as("owner");
    await page.goto("/");
    await expect(page).toHaveURL(/\/dashboard$/);
  });
});

test.describe("the API refuses on its own, whatever the app shows", () => {
  const as = (persona: keyof typeof EMAIL, role = persona as string) => ({
    email: EMAIL[persona],
    role,
  });

  test("a viewer cannot cancel or reschedule: 403 and nothing changes", async () => {
    const id = seeded().free.at(-1)!;
    const cancel = await internal(
      "PATCH",
      `/internal/admin/appointments/${id}/cancel`,
      as("viewer"),
      {
        reason: "viewer tries to cancel",
      },
    );
    const move = await internal(
      "PATCH",
      `/internal/admin/appointments/${id}/reschedule`,
      as("viewer"),
      {
        starts_at: "2030-01-01T09:00:00+03:00",
      },
    );
    expect([cancel.status, move.status]).toEqual([403, 403]);
    const after = await publicApi<{ status: string }>(
      "GET",
      `/appointments/${id}`,
    );
    expect(after.body.status).toBe("booked");
  });

  test("a viewer who claims to be an admin is refused", async () => {
    const res = await internal(
      "GET",
      "/internal/admin/appointments",
      as("viewer", "admin"),
    );
    expect(res.status).toBe(403);
  });

  test("a revoked user is refused even with a valid assertion for the role they used to hold", async () => {
    const res = await internal(
      "GET",
      "/internal/admin/appointments",
      as("revoked", "viewer"),
    );
    expect(res.status).toBe(403);
  });

  test("an admin can read access but cannot grant it directly", async () => {
    const list = await internal("GET", "/internal/admin/access", as("admin"));
    const grant = await internal(
      "POST",
      "/internal/admin/access",
      as("admin"),
      {
        email: "sneaky@clinic.example",
        role: "admin",
      },
    );
    expect([list.status, grant.status]).toEqual([200, 403]);
  });

  test("a viewer can read the dashboard data", async () => {
    const res = await internal(
      "GET",
      "/internal/admin/appointments?limit=1",
      as("viewer"),
    );
    expect(res.status).toBe(200);
  });

  test("the owner can never be revoked, not even by themselves", async () => {
    const path = `/internal/admin/access/${encodeURIComponent(OWNER)}`;
    const res = await internal<{ code: string }>("DELETE", path, {
      email: OWNER,
      role: "owner",
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("OWNER_PROTECTED");
  });

  test("a call with no assertion, or a tampered one, is a 401", async () => {
    expect(
      (await publicApi("GET", "/internal/admin/appointments")).status,
    ).toBe(401);
    const bad = await fetch(
      `${process.env.E2E_API_URL}/internal/admin/appointments`,
      {
        headers: {
          "X-Internal-Assertion": JUNK_ASSERTION,
        },
      },
    );
    expect(bad.status).toBe(401);
  });
});
