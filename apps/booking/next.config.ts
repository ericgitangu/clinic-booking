import { withSerwist } from "@serwist/turbopack";
import type { NextConfig } from "next";
import { legacyHostRedirect } from "./src/lib/legacy-host";

// Cost: no image optimization (it bills), no rewrites (the proxy is an explicit route).
const nextConfig: NextConfig = {
  images: { unoptimized: true },
  transpilePackages: ["@clinic/ui", "@clinic/api"],
  // The old *.vercel.app production host redirects to the branded one (ADR-0028).
  redirects: async () => [legacyHostRedirect],
};

export default withSerwist(nextConfig);
