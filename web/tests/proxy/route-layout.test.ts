import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const API_DIR = fileURLToPath(new URL("../../src/app/api", import.meta.url));

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...routeFiles(full));
    } else if (entry === "route.ts" || entry === "route.tsx") {
      out.push(full);
    }
  }
  return out;
}

describe("src/app/api layout", () => {
  it("has exactly one route handler: [...path]/route.ts", () => {
    const files = routeFiles(API_DIR);
    expect(files).toHaveLength(1);
    expect(files[0].replace(/\\/g, "/")).toContain("[...path]/route.ts");
  });
});
