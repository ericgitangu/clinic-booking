import { describe, expect, it } from "vitest";
import { canonicalJson, signAssertion } from "../src/assertion";

// Produced by backend/app/core/assertion.py (sign) for the same claims and key, so a change on
// either side that breaks the wire format fails here.
const FROM_PYTHON = [
  "v1.eyJhdWQiOiJjbGluaWMtYXBpL2ludGVybmFsI",
  "iwiYmgiOiI5NWVlOTAyZjY1MzlkMmY0N2U3OWE0Y",
  "2ZmM2UwODM4YTQwMGVhNjJiNWQwZDQ1NWQwN2JiN",
  "zdjNTMwNzg4YTM3IiwiZW1haWwiOiJvd25lckBjb",
  "GluaWMuZXhhbXBsZSIsImV4cCI6MTc5MjM4MjQ2M",
  "CwiaWF0IjoxNzkyMzgyNDAwLCJtIjoiUE9TVCIsI",
  "nAiOiIvaW50ZXJuYWwvYWRtaW4vYWNjZXNzP3g9M",
  "SIsInJvbGUiOiJvd25lciIsInN1YiI6InN1Yi0xI",
  "n0.DBDHu2WpPg9J_Qcu8p6hyCR9vWkq1RjPn0OS0",
  "IXvJU4",
].join("");

// The same, with the email-verified claim, signed by the API side's helper.
const FROM_PYTHON_VERIFIED =
  "v1.eyJhdWQiOiJjbGluaWMtYXBpL2ludGVybmFsIiwiYmgiOiIwODRlYmZmZmYxMTE4ZTUzMDE1OWQ2ZTdhMWYwZTFjNWFkN2NlZDE2Njk0ZWJmYjU4ZjVhZTgxZWYzNDlkYWZhIiwiZW1haWwiOiJvd25lckBjbGluaWMuZXhhbXBsZSIsImV2Ijp0cnVlLCJleHAiOjE3OTIzODI0NjAsImlhdCI6MTc5MjM4MjQwMCwibSI6IlBPU1QiLCJwIjoiL2ludGVybmFsL2FjY291bnRzL2xpbmsiLCJyb2xlIjoicGF0aWVudCIsInN1YiI6InN1Yi0xIn0.wN5pH-ZNj9s1wxsLIbc6Z5Ed_AGyKI3ea-aTKvV7nz4";

describe("signed assertion", () => {
  it("carries the email-verified claim exactly as the API side signs it", () => {
    const header = signAssertion(
      {
        sub: "sub-1",
        email: "owner@clinic.example",
        role: "patient",
        emailVerified: true,
        method: "post",
        path: "/internal/accounts/link",
        body: '{"full_name":"A B"}',
        now: new Date("2026-10-19T04:00:00Z"),
      },
      "k".repeat(32),
    );
    expect(header).toBe(FROM_PYTHON_VERIFIED);
  });

  it("leaves the claim out when it is not given, so staff assertions are unchanged", () => {
    const header = signAssertion(
      {
        sub: "s",
        email: "e@x.io",
        role: "owner",
        method: "GET",
        path: "/p",
        body: "",
        now: new Date(0),
      },
      "k".repeat(32),
    );
    const payload = JSON.parse(
      Buffer.from(header.split(".")[1], "base64url").toString(),
    );
    expect("ev" in payload).toBe(false);
  });

  it("is byte-identical to the one the API side produces", () => {
    const header = signAssertion(
      {
        sub: "sub-1",
        email: "owner@clinic.example",
        role: "owner",
        method: "post",
        path: "/internal/admin/access?x=1",
        body: '{"email":"é@x.io","role":"viewer"}',
        now: new Date("2026-10-19T04:00:00Z"),
      },
      "k".repeat(32),
    );
    expect(header).toBe(FROM_PYTHON);
  });

  it("sorts keys at every level and leaves no whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [{ z: 1, y: 2 }] } })).toBe(
      '{"a":{"c":[{"y":2,"z":1}],"d":2},"b":1}',
    );
  });

  it("changes when the body changes", () => {
    const base = {
      sub: "s",
      email: "e@x.io",
      role: "owner",
      method: "GET",
      path: "/p",
      now: new Date("2026-10-19T04:00:00Z"),
    };
    const a = signAssertion({ ...base, body: "" }, "k".repeat(32));
    const b = signAssertion({ ...base, body: "{}" }, "k".repeat(32));
    expect(a).not.toBe(b);
  });
});
