import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { zProblemCode } from "@clinic/api/generated/zod.gen";
import { DECISIONS } from "@/content/decisions";
import { DECISION_CARDS } from "@/content/architecture";
import {
  BONUS,
  REQUIRED,
  STEPS,
  TILES,
  decisionHref,
  swaggerLink,
} from "@/lib/evidence";

// The landing page makes claims about the API; each one is checked here against the contract.
const spec = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../../../../contracts/openapi.json", import.meta.url),
    ),
    "utf8",
  ),
) as Record<
  string,
  Record<
    string,
    Record<
      string,
      {
        operationId: string;
        tags: string[];
        responses: Record<string, unknown>;
      }
    >
  >
>;

const all = [...REQUIRED, ...BONUS];

describe("the evidence cards match the contract", () => {
  it.each(all.map((e) => [`${e.method} ${e.path}`, e] as const))(
    "%s exists with the stated operation id, tag and statuses",
    (_n, e) => {
      const op = spec.paths[e.path]?.[e.method.toLowerCase()];
      expect(op, "operation is in the contract").toBeDefined();
      expect(op.operationId).toBe(e.operationId);
      expect(op.tags).toContain(e.tag);
      for (const err of e.errors) {
        expect(
          Object.keys(op.responses),
          `${err.status} is documented`,
        ).toContain(String(err.status));
      }
    },
  );

  it("only names problem codes that exist", () => {
    const codes = new Set<string>(zProblemCode.options);
    for (const e of all)
      for (const err of e.errors)
        expect(codes.has(err.code), err.code).toBe(true);
  });

  it("builds the Swagger deep link as /docs#/<tag>/<operationId>", () => {
    expect(swaggerLink(REQUIRED[0])).toBe(
      "/docs#/appointments/create_appointment_appointments_post",
    );
  });

  it("covers the four required operations and the two bonuses", () => {
    expect(REQUIRED.map((e) => `${e.method} ${e.path}`)).toEqual([
      "POST /appointments",
      "GET /doctors/{doctor_id}/availability",
      "PATCH /appointments/{appointment_id}/cancel",
      "PATCH /appointments/{appointment_id}/reschedule",
    ]);
    expect(BONUS).toHaveLength(2);
  });

  it("links every screen to a route that exists", () => {
    for (const e of all)
      expect(["/book", "/appointments"]).toContain(e.screen.href);
  });
});

describe("the verification steps and the architecture tiles", () => {
  it("sends the front-door tile to the front-door decision, and states one cost figure", () => {
    const door = TILES.find(
      (t) => "extra" in t && t.extra.label === "Read the front-door decision",
    );
    expect(door && "extra" in door && door.extra.href).toBe(
      "/decisions#decision-23",
    );
    expect(DECISION_CARDS.find((a) => a.id === "decision-23")?.title).toMatch(
      /front door/,
    );
    const cost = TILES.find((t) => t.title.startsWith("$0"));
    expect(cost?.body).toContain("about $0.35 a month against a $0.50 ceiling");
  });

  it("has three steps that target the live API", () => {
    expect(STEPS).toHaveLength(3);
    expect(STEPS[0].code).toContain("https://clinic.ericgitangu.com/api");
    expect(STEPS[2].body).toContain("409");
  });

  it("points every tile at a /decisions entry that exists", () => {
    const ids = new Set(DECISIONS.map((d) => d.id));
    for (const t of TILES) {
      expect("decision" in t || "extra" in t, t.title).toBe(true);
      if (!("decision" in t)) continue;
      expect(ids.has(t.decision), t.decision).toBe(true);
      expect(decisionHref(t.decision)).toBe(`/decisions#${t.decision}`);
    }
  });
});
