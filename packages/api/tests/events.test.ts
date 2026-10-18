import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { zAdminEvent, zSlotEvent } from "../src/generated/zod.gen";

// The pushed messages (contracts/events, exported from the backend models) and the generated zod
// schemas must say the same thing, and neither may carry personal data.
const root = new URL("../../../contracts/", import.meta.url);
const read = (path: string) =>
  JSON.parse(readFileSync(new URL(path, root), "utf8"));

const slot = {
  doctor_id: "11111111-1111-4111-8111-111111111111",
  local_date: "2026-10-26",
  starts_at: "2026-10-26T06:00:00.000000Z",
  kind: "slot_taken",
  seq: "770.41.1",
};
const admin = {
  event_type: "rescheduled",
  doctor_id: "11111111-1111-4111-8111-111111111111",
  local_date: "2026-10-27",
  from_local_date: "2026-10-26",
  from_starts_at: "2026-10-26T06:00:00.000000Z",
  to_starts_at: "2026-10-27T06:00:00.000000Z",
  seq: "770.41",
};
const BANNED = /appointment|patient|phone|email|reason|name|occurred|txid/i;

describe("event contract v1", () => {
  it("accepts a slot event and an admin event", () => {
    expect(zSlotEvent.safeParse(slot).success).toBe(true);
    expect(zAdminEvent.safeParse(admin).success).toBe(true);
    expect(zSlotEvent.safeParse({ ...slot, kind: "slot_freed" }).success).toBe(
      true,
    );
  });

  it("never passes a personal or identifying field through, and rejects malformed values", () => {
    // The generated zod objects strip unknown keys (they are not strict); the JSON Schemas and
    // the backend models forbid them outright, which the next test and the backend tests check.
    for (const extra of [
      "appointment_id",
      "patient_id",
      "email",
      "occurred_at",
    ]) {
      const s = zSlotEvent.safeParse({ ...slot, [extra]: "x" });
      expect(s.success && extra in s.data, extra).toBe(false);
      const a = zAdminEvent.safeParse({ ...admin, [extra]: "x" });
      expect(a.success && extra in a.data, extra).toBe(false);
    }
    expect(zSlotEvent.safeParse({ ...slot, kind: "slot_moved" }).success).toBe(
      false,
    );
    expect(zSlotEvent.safeParse({ ...slot, seq: "770.41" }).success).toBe(
      false,
    );
    expect(zSlotEvent.safeParse({ ...slot, seq: "-1.2.1" }).success).toBe(
      false,
    );
    expect(zAdminEvent.safeParse({ ...admin, seq: "770.41.1" }).success).toBe(
      false,
    );
  });

  it("matches the JSON Schemas under contracts/events and carries no personal field", () => {
    for (const [file, zod, example] of [
      ["events/slot-event.v1.schema.json", zSlotEvent, slot],
      ["events/admin-event.v1.schema.json", zAdminEvent, admin],
    ] as const) {
      const schema = read(file);
      expect(schema.additionalProperties).toBe(false);
      expect(Object.keys(schema.properties).join(" ")).not.toMatch(BANNED);
      expect(new Set(schema.required)).toEqual(new Set(Object.keys(example)));
      expect(new Set(Object.keys(zod.shape))).toEqual(
        new Set(Object.keys(example)),
      );
    }
    const spec = read("openapi.json").components.schemas;
    expect(Object.keys(spec.SlotEvent.properties).sort()).toEqual(
      Object.keys(read("events/slot-event.v1.schema.json").properties).sort(),
    );
  });
});
