import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Files inside @clinic/ui import each other by package name; map that to the source tree.
export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@clinic\/ui\/(components|lib)\/(.*)$/,
        replacement:
          fileURLToPath(new URL("./src", import.meta.url)) + "/$1/$2",
      },
    ],
  },
  test: { environment: "node", include: ["tests/**/*.test.{ts,tsx}"] },
});
