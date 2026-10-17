import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const ui = fileURLToPath(new URL("../../packages/ui/src", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      // Files inside @clinic/ui import each other by package name; map that to the source tree.
      {
        find: /^@clinic\/ui\/(components|lib)\/(.*)$/,
        replacement: ui + "/$1/$2",
      },
      {
        find: "@",
        replacement: fileURLToPath(new URL("./src", import.meta.url)),
      },
    ],
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.{ts,tsx}"],
  },
});
