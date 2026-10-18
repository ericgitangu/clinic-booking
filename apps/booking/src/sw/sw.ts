// The service worker: it caches the static app shell and nothing else.
//
// Cached: content-hashed files under /_next/static (immutable by name), the brand images, and one
// offline page precached at install. Everything else goes to the network untouched: navigations
// (so no page, signed in or not, is ever stored), RSC payloads, /api, /auth, /admin and every
// non-GET request such as a server action. A route with no handler here is not intercepted at all.
// When a navigation fails offline, the precached offline page is shown instead.
import {
  CacheFirst,
  ExpirationPlugin,
  NetworkOnly,
  Serwist,
  type PrecacheEntry,
  type SerwistGlobalConfig,
} from "serwist";

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}
declare const self: ServiceWorkerGlobalScope;

const OFFLINE_URL = "/offline.html";
const neverCached = /^\/(api|auth|admin)(\/|$)/;

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  // Only the app's own shell is ever precached; old entries go when the worker updates.
  precacheOptions: { cleanupOutdatedCaches: true },
  runtimeCaching: [
    {
      // Never cached, and listed first so no later rule can ever match them.
      matcher: ({ request, sameOrigin, url }) =>
        sameOrigin &&
        (neverCached.test(url.pathname) ||
          request.mode === "navigate" ||
          request.method !== "GET" ||
          request.headers.has("RSC") ||
          request.headers.has("Next-Action") ||
          url.searchParams.has("_rsc")),
      handler: new NetworkOnly(),
    },
    {
      matcher: ({ sameOrigin, url }) =>
        sameOrigin && url.pathname.startsWith("/_next/static/"),
      handler: new CacheFirst({
        cacheName: "shell-static",
        plugins: [new ExpirationPlugin({ maxEntries: 64 })],
      }),
    },
    {
      matcher: ({ sameOrigin, url }) =>
        sameOrigin && url.pathname.startsWith("/brand/"),
      handler: new CacheFirst({
        cacheName: "shell-brand",
        plugins: [new ExpirationPlugin({ maxEntries: 16 })],
      }),
    },
  ],
  fallbacks: {
    entries: [
      {
        url: OFFLINE_URL,
        matcher: ({ request }) => request.destination === "document",
      },
    ],
  },
});

serwist.addEventListeners();
