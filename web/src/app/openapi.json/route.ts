import spec from "@/generated/openapi.public.json";

// Static: prerendered at build from the committed contract (servers: [{"url":"/api"}]).
// No upstream fetch, so no query string can turn it into Cloud Run egress (§12.4).
export const dynamic = "force-static";

export async function GET(): Promise<Response> {
  return Response.json(spec);
}

export async function HEAD(): Promise<Response> {
  return new Response(null, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
