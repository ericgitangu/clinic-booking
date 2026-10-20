import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { API } from "@/content/architecture/api";

// The error table on /architecture is checked against the catalogue the API serves from, so it
// cannot drift once the markdown copy is gone.
const source = readFileSync(
  fileURLToPath(
    new URL("../../../../backend/app/domain/errors.py", import.meta.url),
  ),
  "utf8",
);
const inCode = new Map<string, number>(
  [...source.matchAll(/ErrorSpec\(\s*"([A-Z_]+)",\s*(\d{3}),/g)].map((m) => [
    m[1]!,
    Number(m[2]),
  ]),
);

const table = API.cards
  .find((c) => c.id === "api-errors")
  ?.blocks.find((b) => b.t === "table");

describe("error catalogue on the page", () => {
  it("lists exactly the codes the API defines, with the same status", () => {
    expect(inCode.size).toBeGreaterThan(30);
    expect(table?.t).toBe("table");
    if (table?.t !== "table") return;
    const onPage = new Map(
      table.rows.map((r) => [r[0]!.replaceAll("`", ""), Number(r[1])]),
    );
    expect(onPage).toEqual(inCode);
  });
});
