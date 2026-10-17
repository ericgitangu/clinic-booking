import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as sdk from "../src/generated";
import * as zod from "../src/generated/zod.gen";

// A smoke test: the generated output covers everything the contract declares. Field-level drift
// (names, enums, formats, nesting) cannot slip in because the schemas are generated, and CI fails
// when the generated files differ from a fresh run (see drift.test.ts and the lint job).
const spec = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../contracts/openapi.json", import.meta.url)),
    "utf8",
  ),
) as {
  components: { schemas: Record<string, unknown> };
  paths: Record<string, Record<string, { operationId: string }>>;
};

const camel = (id: string) =>
  id.replace(/_+([a-z0-9])/g, (_, c: string) => c.toUpperCase());

describe("generated output covers the contract", () => {
  it("has a zod schema for every component", () => {
    const have = new Set(Object.keys(zod).map((k) => k.toLowerCase()));
    for (const name of Object.keys(spec.components.schemas)) {
      expect(have.has(`z${name}`.toLowerCase()), name).toBe(true);
    }
  });

  it("has an SDK function for every operation", () => {
    const have = new Set(Object.keys(sdk).map((k) => k.toLowerCase()));
    for (const methods of Object.values(spec.paths)) {
      for (const op of Object.values(methods)) {
        expect(
          have.has(camel(op.operationId).toLowerCase()),
          op.operationId,
        ).toBe(true);
      }
    }
  });
});
