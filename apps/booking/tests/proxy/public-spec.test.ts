import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as openapiRoute from "@/app/openapi.json/route";
import { toPublicSpec } from "../../scripts/public-spec.mjs";

type Spec = {
  paths: Record<string, Record<string, { tags?: string[] }>>;
  components: { schemas: Record<string, unknown> };
  tags?: { name: string }[];
};

const contract = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../../../../contracts/openapi.json", import.meta.url),
    ),
    "utf8",
  ),
) as Spec;

// The five endpoints the brief asks for.
const BRIEF = [
  ["get", "/doctors"],
  ["get", "/doctors/{doctor_id}/availability"],
  ["post", "/appointments"],
  ["patch", "/appointments/{appointment_id}/cancel"],
  ["get", "/patients/{patient_id}/appointments"],
] as const;

function refs(node: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(node)) node.forEach((n) => refs(n, into));
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === "$ref" && typeof v === "string") into.add(v);
      else refs(v, into);
    }
  }
  return into;
}

describe("the public spec", () => {
  const served = async () =>
    (await openapiRoute.GET().then((r: Response) => r.json())) as Spec;

  it("the contract does describe internal paths (so the filter has work to do)", () => {
    expect(
      Object.keys(contract.paths).filter((p) => p.startsWith("/internal"))
        .length,
    ).toBeGreaterThan(0);
  });

  it("the served /openapi.json has no /internal path at all", async () => {
    const spec = await served();
    expect(
      Object.keys(spec.paths).filter((p) => p.includes("internal")),
    ).toEqual([]);
    expect(JSON.stringify(spec)).not.toMatch(/\/internal/);
  });

  it("the served /openapi.json keeps the brief's five endpoints", async () => {
    const spec = await served();
    for (const [method, path] of BRIEF) {
      expect(spec.paths[path]?.[method], `${method} ${path}`).toBeDefined();
    }
  });

  it("no operation is left under the admin tag, and no admin tag is declared", async () => {
    const spec = await served();
    for (const ops of Object.values(spec.paths)) {
      for (const op of Object.values(ops))
        expect(op.tags ?? []).not.toContain("admin");
    }
    expect((spec.tags ?? []).map((t) => t.name)).not.toContain("admin");
  });

  it("every schema left is reachable, and every reference resolves (no orphans)", async () => {
    const spec = await served();
    const prefix = "#/components/schemas/";
    const reached = new Set<string>();
    const queue = [...refs(spec.paths)];
    while (queue.length) {
      const ref = queue.pop()!;
      if (reached.has(ref)) continue;
      reached.add(ref);
      expect(
        spec.components.schemas[ref.slice(prefix.length)],
        ref,
      ).toBeDefined();
      queue.push(...refs(spec.components.schemas[ref.slice(prefix.length)]));
    }
    expect(
      Object.keys(spec.components.schemas)
        .map((n) => prefix + n)
        .sort(),
    ).toEqual([...reached].sort());
  });

  it("admin-only schemas are gone", async () => {
    const spec = await served();
    for (const name of [
      "Metrics",
      "AccessEntry",
      "AccessList",
      "Lineage",
      "GrantRequest",
    ]) {
      expect(spec.components.schemas[name], name).toBeUndefined();
    }
  });

  it("the committed snapshot matches the filtered contract, so a stale snapshot fails", async () => {
    const expected = toPublicSpec(contract) as Spec & { servers?: unknown };
    expected.servers = [{ url: "/api" }];
    expect(await served()).toEqual(expected);
  });

  it("filtering drops only what is internal: every public path survives", () => {
    const filtered = toPublicSpec(contract) as Spec;
    const publicPaths = Object.keys(contract.paths).filter(
      (p) => !p.startsWith("/internal"),
    );
    expect(Object.keys(filtered.paths).sort()).toEqual(publicPaths.sort());
  });
});
