import { beforeEach, describe, expect, it, vi } from "vitest";
import { sign, verify } from "@/lib/cookie-sign";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (k: string) => (jar.has(k) ? { value: jar.get(k) } : undefined),
    set: (k: string, v: string) => void jar.set(k, v),
    delete: (k: string) => void jar.delete(k),
  }),
}));
import {
  cookieConfigured,
  readPatient,
  rememberPatient,
} from "@/lib/patient-cookie";

const SECRET = "s".repeat(40);
const ID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  jar.clear();
  process.env.CLINIC_COOKIE_SECRET = SECRET;
});

describe("signed values", () => {
  it("round-trips a payload", () => {
    expect(verify(sign("hello", SECRET), SECRET)).toBe("hello");
  });
  it("rejects a value signed with another secret", () => {
    expect(verify(sign("hello", "x".repeat(40)), SECRET)).toBeNull();
  });
  it("rejects a payload that was altered after signing", () => {
    const [, mac] = sign("a", SECRET).split(".");
    const forged = `${Buffer.from("b").toString("base64url")}.${mac}`;
    expect(verify(forged, SECRET)).toBeNull();
  });
  it("rejects unsigned, truncated and malformed values", () => {
    for (const v of ["", "abc", "a.b.c", ".", "abc.", ".abc"])
      expect(verify(v, SECRET)).toBeNull();
  });
  it("rejects everything when the secret is missing or short, and refuses to sign", () => {
    expect(verify(sign("hi", SECRET), undefined)).toBeNull();
    expect(verify(sign("hi", SECRET), "short")).toBeNull();
    expect(() => sign("hi", "short")).toThrow();
  });
});

describe("the remembered patient", () => {
  it("is read back after it was remembered", async () => {
    await rememberPatient({ id: ID, name: "Amina" });
    expect(await readPatient()).toEqual({ id: ID, name: "Amina" });
  });

  it("ignores a cookie holding someone else's id with no valid signature", async () => {
    jar.set("clinic_patient", JSON.stringify({ id: OTHER, name: "Victim" }));
    expect(await readPatient()).toBeNull();
  });

  it("ignores a forged cookie with a made-up signature", async () => {
    const body = Buffer.from(
      JSON.stringify({ id: OTHER, name: "Victim" }),
    ).toString("base64url");
    jar.set("clinic_patient", `${body}.${"A".repeat(43)}`);
    expect(await readPatient()).toBeNull();
  });

  it("ignores a validly signed cookie once the secret changes", async () => {
    await rememberPatient({ id: ID, name: "Amina" });
    process.env.CLINIC_COOKIE_SECRET = "n".repeat(40);
    expect(await readPatient()).toBeNull();
  });

  it("ignores a validly signed cookie whose id is not a UUID", async () => {
    jar.set(
      "clinic_patient",
      sign(JSON.stringify({ id: "1 OR 1=1", name: "x" }), SECRET),
    );
    expect(await readPatient()).toBeNull();
  });

  it("refuses to remember anyone without the secret, and says it is not configured", async () => {
    delete process.env.CLINIC_COOKIE_SECRET;
    expect(cookieConfigured()).toBe(false);
    await expect(rememberPatient({ id: ID, name: "Amina" })).rejects.toThrow();
  });
});
