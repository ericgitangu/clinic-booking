import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import * as s from "../src/schemas";

const spec = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../contracts/openapi.json", import.meta.url)),
    "utf8",
  ),
) as {
  components: {
    schemas: Record<
      string,
      { properties: Record<string, unknown>; required?: string[] }
    >;
  };
};

// zod 4 object schemas expose their shape; optional fields have `optional` set on the instance.
function shapeOf(schema: z.ZodType) {
  const shape = (schema as unknown as { shape: Record<string, z.ZodType> })
    .shape;
  const keys = Object.keys(shape).sort();
  const required = keys.filter((k) => !shape[k].safeParse(undefined).success);
  return { keys, required };
}

const PAIRS: [string, z.ZodType][] = [
  ["Clinic", s.ClinicSchema],
  ["WorkingWindow", s.WorkingWindowSchema],
  ["Doctor", s.DoctorSchema],
  ["DoctorList", s.DoctorListSchema],
  ["Slot", s.SlotSchema],
  ["Availability", s.AvailabilitySchema],
  ["Patient", s.PatientSchema],
  ["Appointment", s.AppointmentSchema],
  ["DoctorRef", s.DoctorRefSchema],
  ["AppointmentWithDoctor", s.AppointmentWithDoctorSchema],
  ["PatientAppointments", s.PatientAppointmentsSchema],
];

describe("zod schemas follow contracts/openapi.json", () => {
  it.each(PAIRS)("%s has the same fields and required set", (name, schema) => {
    const def = spec.components.schemas[name];
    const { keys, required } = shapeOf(schema);
    expect(keys).toEqual(Object.keys(def.properties).sort());
    expect(required).toEqual([...(def.required ?? [])].sort());
  });

  it("lists the problem codes the screens handle as a subset of the contract", () => {
    const enumValues = (
      spec.components.schemas.ProblemCode as unknown as { enum: string[] }
    ).enum;
    for (const code of s.PROBLEM_CODES) expect(enumValues).toContain(code);
  });
});
