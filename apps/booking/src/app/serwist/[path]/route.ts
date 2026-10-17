// Builds the service worker (src/sw/sw.ts) at `next build` and serves it from /serwist/sw.js.
// Serwist's webpack plugin does not run under Turbopack; this route is its documented replacement.
// The precache list is generated from the build output: .next/static and everything in public/
// (including public/offline.html, the page shown when a navigation fails offline). Server-rendered
// pages are not files, so none of them can be in it.
import { createSerwistRoute } from "@serwist/turbopack";

export const { dynamic, dynamicParams, revalidate, generateStaticParams, GET } =
  createSerwistRoute({
    swSrc: "src/sw/sw.ts",
    useNativeEsbuild: true,
  });
