import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildUpstream, resumeCursor } from "@/lib/live-upstream";

const KEY = "k".repeat(40);
const NOW = new Date("2026-10-19T04:00:00Z");

function claims(header: string) {
  const [v, payload, mac] = header.split(".");
  expect(v).toBe("v1");
  expect(createHmac("sha256", KEY).update(payload).digest("base64url")).toBe(
    mac,
  );
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

describe("resumeCursor", () => {
  it("takes the query parameter, then Last-Event-ID, and only well-formed values", () => {
    expect(resumeCursor("12.34", "1.1")).toBe("12.34");
    expect(resumeCursor(null, "1.1")).toBe("1.1");
    expect(resumeCursor("nope", "5.6")).toBe("5.6");
    expect(resumeCursor("01.2", null)).toBeNull();
    expect(resumeCursor("1.2; DROP", null)).toBeNull();
    expect(resumeCursor(null, null)).toBeNull();
    expect(resumeCursor("1".repeat(21) + ".1", null)).toBeNull();
  });
});

describe("buildUpstream", () => {
  const who = { sub: "g-1", email: "owner@clinic.example", role: "owner" };

  it("signs the assertion for exactly the target it requests", () => {
    const r = buildUpstream({
      base: "https://rt.example/",
      who,
      cursor: "12.34",
      signingKey: KEY,
      now: NOW,
      idToken: null,
    });
    expect(r.url).toBe("https://rt.example/stream?cursor=12.34");
    const c = claims(r.headers["X-Internal-Assertion"]);
    expect(c).toMatchObject({
      aud: "clinic-api/internal",
      sub: "g-1",
      email: "owner@clinic.example",
      role: "owner",
      m: "GET",
      p: "/stream?cursor=12.34",
      bh: createHash("sha256").update("").digest("hex"),
      ev: true,
    });
    expect(c.exp - c.iat).toBe(60);
  });

  it("asks for a fresh stream without a cursor, and adds the IAM token only when there is one", () => {
    const plain = buildUpstream({
      base: "http://127.0.0.1:8090",
      who,
      cursor: null,
      signingKey: KEY,
      now: NOW,
      idToken: null,
    });
    expect(plain.url).toBe("http://127.0.0.1:8090/stream");
    expect(claims(plain.headers["X-Internal-Assertion"]).p).toBe("/stream");
    expect(plain.headers["x-serverless-authorization"]).toBeUndefined();
    const iam = buildUpstream({
      base: "https://rt.example",
      who,
      cursor: null,
      signingKey: KEY,
      now: NOW,
      idToken: "tok",
    });
    expect(iam.headers["x-serverless-authorization"]).toBe("Bearer tok");
  });
});
