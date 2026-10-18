import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

// What this proves: if the contract changes, code written against the old contract stops
// compiling (type-check) and the old payloads stop validating (runtime). It regenerates from a
// changed copy of the spec into a scratch folder, so nothing under src/generated is touched.
const PKG = fileURLToPath(new URL("..", import.meta.url));
const SPEC = fileURLToPath(
  new URL("../../../contracts/openapi.json", import.meta.url),
);
const BIN = `${PKG}node_modules/.bin`;

type Spec = {
  components: {
    schemas: Record<
      string,
      { properties: Record<string, unknown>; required?: string[] }
    >;
  };
};

function generate(name: string, mutate: (s: Spec) => void, consumer: string) {
  const dir = `${PKG}.drift-tmp/${name}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const spec = JSON.parse(readFileSync(SPEC, "utf8")) as Spec;
  mutate(spec);
  writeFileSync(`${dir}/openapi.json`, JSON.stringify(spec));
  // The same plugins and options as openapi-ts.config.ts, with the input and output moved.
  writeFileSync(
    `${dir}/openapi-ts.config.ts`,
    `import { defineConfig } from "@hey-api/openapi-ts";
export default defineConfig({
  input: "${dir}/openapi.json",
  output: { path: "${dir}/out", clean: true },
  plugins: ["@hey-api/typescript", { name: "zod", dates: { offset: true } }],
});
`,
  );
  execFileSync(`${BIN}/openapi-ts`, ["-f", `${dir}/openapi-ts.config.ts`], {
    cwd: PKG,
    stdio: "pipe",
  });
  writeFileSync(`${dir}/consumer.ts`, consumer);
  writeFileSync(
    `${dir}/tsconfig.json`,
    JSON.stringify({
      extends: "../../tsconfig.json",
      include: ["./**/*.ts"],
      compilerOptions: { baseUrl: "." },
    }),
  );
  let output = "";
  let ok = true;
  try {
    execFileSync(`${BIN}/tsc`, ["--noEmit", "-p", `${dir}/tsconfig.json`], {
      cwd: PKG,
      stdio: "pipe",
    });
  } catch (e) {
    ok = false;
    output = String((e as { stdout?: Buffer }).stdout ?? "");
  }
  return { dir, typechecks: ok, output };
}

async function zAppointment(dir: string) {
  const mod = (await import(pathToFileURL(`${dir}/out/zod.gen.ts`).href)) as {
    zAppointment: { safeParse: (v: unknown) => { success: boolean } };
  };
  return mod.zAppointment;
}

const NOW = "2026-10-17T08:00:00Z";
const ID = "11111111-1111-4111-8111-111111111111";
// A payload as the API sends it today; the control test checks the generated schema accepts it.
const oldPayload = {
  id: ID,
  doctor_id: ID,
  patient_id: ID,
  starts_at: "2026-10-20T09:00:00+03:00",
  ends_at: "2026-10-20T09:30:00+03:00",
  status: "cancelled",
  cancellation_reason: "x",
  cancelled_at: NOW,
  created_at: NOW,
  updated_at: NOW,
  timezone: "Africa/Nairobi",
};

const READS_FIELD = `import type { Appointment } from "./out/types.gen";\nexport const startOf = (a: Appointment): string => a.starts_at;\n`;
const USES_ENUM = `import type { Appointment } from "./out/types.gen";\nexport const s: Appointment["status"] = "cancelled";\n`;

describe("a change to the contract is caught", () => {
  it("control: the unchanged contract type-checks the same code and accepts the old payload", async () => {
    const g = generate(
      "control",
      () => {},
      READS_FIELD + USES_ENUM.split("\n").slice(1).join("\n"),
    );
    expect(g.typechecks, g.output).toBe(true);
    expect((await zAppointment(g.dir)).safeParse(oldPayload).success).toBe(
      true,
    );
  }, 60_000);

  it("a field renamed in the spec fails type-checking and fails at runtime", async () => {
    const g = generate(
      "rename",
      (s) => {
        const a = s.components.schemas.Appointment;
        a.properties.begins_at = a.properties.starts_at;
        delete a.properties.starts_at;
        a.required = (a.required ?? []).map((f) =>
          f === "starts_at" ? "begins_at" : f,
        );
      },
      READS_FIELD,
    );
    expect(g.typechecks).toBe(false);
    expect(g.output).toContain("starts_at");
    expect((await zAppointment(g.dir)).safeParse(oldPayload).success).toBe(
      false,
    );
  }, 60_000);

  it("an enum value changed in the spec fails type-checking and fails at runtime", async () => {
    const g = generate(
      "enum",
      (s) => {
        const status = s.components.schemas.Appointment.properties.status as {
          enum: string[];
        };
        status.enum = status.enum.map((v) =>
          v === "cancelled" ? "canceled" : v,
        );
      },
      USES_ENUM,
    );
    expect(g.typechecks).toBe(false);
    expect(g.output).toContain("cancelled");
    expect((await zAppointment(g.dir)).safeParse(oldPayload).success).toBe(
      false,
    );
  }, 60_000);
});
