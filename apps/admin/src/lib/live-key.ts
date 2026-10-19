import "server-only";
import { createHash } from "node:crypto";

/**
 * The key a browser's tabs share their one live stream under (live-share.ts): the same for every
 * tab of one person, different for another person signed in to the same browser later. A digest,
 * so the page never carries the sign-in provider's own subject.
 */
export function liveKey(sub: string): string {
  return createHash("sha256")
    .update(`clinic-live:${sub}`)
    .digest("base64url")
    .slice(0, 22);
}
