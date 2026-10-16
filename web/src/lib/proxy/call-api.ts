// In-process forwarding to the API for server routes (S3/S4 use this; unused in lean core).
import { forward } from "@/lib/proxy/forward";
import { mintIdToken, minting_enabled } from "@/lib/proxy/gcp-id-token";

export async function callApi(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const baseUrl = process.env.API_URL ?? "";
  const audience = process.env.API_AUDIENCE ?? "clinic-api";
  const token = minting_enabled() ? await mintIdToken(audience) : null;
  const req = new Request(`https://proxy.internal/api${path}`, init);
  return forward(req, { baseUrl, upstreamPath: path, token });
}
