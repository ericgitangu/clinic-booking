import { defineConfig } from "@hey-api/openapi-ts";

// Generates the TypeScript types, the zod schemas, the SDK and the TanStack Query options from the committed contract. Nothing under
// src/generated is edited by hand: `make gen-client` rewrites it and CI fails if it is out of date.
export default defineConfig({
  input: "../../contracts/openapi.json",
  output: { path: "src/generated", clean: true },
  plugins: [
    "@hey-api/typescript",
    // The API sends times with a Nairobi offset (+03:00); plain z.iso.datetime() would refuse them.
    { name: "zod", dates: { offset: true } },
    "@hey-api/client-fetch",
    { name: "@hey-api/sdk", validator: true },
    // Query hooks and query keys for the browser, built on the SDK above so the same zod checks run.
    "@tanstack/react-query",
  ],
});
