// Builds the service worker (src/sw/sw.ts) at `next build` and serves it from /serwist/sw.js.
// Serwist's webpack plugin does not run under Turbopack; this route is its documented replacement.
// Only public/offline.html (shown when a navigation fails offline) is precached. The default would
// precache all of .next/static at install; about 70 parallel fetches competed with the page's own
// loads and stalled the first navigations in a new tab by seconds. Static files are cached as they
// are used instead (src/sw/sw.ts), which also keeps the install to one request.
import { createSerwistRoute } from "@serwist/turbopack";

export const { dynamic, dynamicParams, revalidate, generateStaticParams, GET } =
  createSerwistRoute({
    swSrc: "src/sw/sw.ts",
    globPatterns: ["public/offline.html"],
    useNativeEsbuild: true,
  });
