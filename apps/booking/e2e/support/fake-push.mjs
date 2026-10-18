// A LOCAL STAND-IN for the push service (Ably), for running the live-update scenarios on a machine
// that has no Ably key. CI runs the same scenarios against the real service instead (context
// `ably-ci`); this file is never used there. It speaks only what the booking app relies on, as
// observed against the real service (contracts/events/README.md):
//   POST /messages          batch publish with Basic auth; a repeated message id is delivered once
//   GET  /event-stream      Authorization: Bearer <jwt>; a refused or expired token is an
//                           `event: error` frame on a 200 stream; the stream ends at token expiry
// plus two test-only controls: POST /__redeliver and GET /__stats.
import { createHmac } from "node:crypto";
import { createServer } from "node:http";

const PORT = Number(process.env.FAKE_PUSH_PORT ?? 3199);
const SECRET = process.env.FAKE_PUSH_SECRET ?? "localsecretlocalsecret1234";

const subscribers = new Map(); // channel -> Set<res>
const seen = new Map(); // channel -> Map<id, frame>
const stats = { connections: 0, published: 0, delivered: 0 };

const b64 = (s) => Buffer.from(s, "base64url").toString("utf8");
function verify(auth) {
  const jwt = (auth ?? "").replace(/^Bearer\s+/i, "");
  const [h, p, sig] = jwt.split(".");
  if (!h || !p || !sig) return { code: 40142 };
  const good = createHmac("sha256", SECRET)
    .update(`${h}.${p}`)
    .digest("base64url");
  if (good !== sig) return { code: 40144 };
  const claims = JSON.parse(b64(p));
  if (claims.exp * 1000 <= Date.now()) return { code: 40142 };
  return { claims };
}

function frame(channel, m) {
  return `event: message\ndata: ${JSON.stringify({ id: m.id, name: m.name, data: m.data, channel })}\n\n`;
}
function broadcast(channel, text) {
  for (const res of subscribers.get(channel) ?? []) {
    res.write(text);
    stats.delivered++;
  }
}

createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
  if (req.method === "OPTIONS") return res.writeHead(204).end();

  if (req.method === "POST" && url.pathname === "/messages") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      for (const spec of JSON.parse(body)) {
        for (const channel of spec.channels) {
          for (const m of spec.messages) {
            stats.published++;
            const ids = seen.get(channel) ?? new Map();
            seen.set(channel, ids);
            if (ids.has(m.id)) continue; // the real service drops a repeated id
            const f = frame(channel, m);
            ids.set(m.id, f);
            broadcast(channel, f);
          }
        }
      }
      res.writeHead(201, { "content-type": "application/json" }).end("{}");
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/__redeliver") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { channel, id } = JSON.parse(body);
      const f = seen.get(channel)?.get(id);
      if (f) broadcast(channel, f);
      res.writeHead(f ? 200 : 404).end();
    });
    return;
  }

  if (url.pathname === "/__last") {
    const ids = [
      ...(seen.get(url.searchParams.get("channel") ?? "")?.keys() ?? []),
    ];
    return res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ id: ids.at(-1) ?? null }));
  }

  if (url.pathname === "/__stats") {
    const open = [...subscribers.values()].reduce((n, s) => n + s.size, 0);
    return res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ ...stats, open }));
  }

  if (url.pathname === "/event-stream") {
    stats.connections++;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    const error = (code) =>
      res.end(
        `event: error\ndata: ${JSON.stringify({ message: "refused", code, statusCode: 401 })}\n\n`,
      );
    const v = verify(req.headers.authorization);
    if (!v.claims) return error(v.code);
    const channel = url.searchParams.get("channels") ?? "";
    const cap = JSON.parse(v.claims["x-ably-capability"] ?? "{}");
    if (!(channel in cap)) return error(40160);
    res.write(": connected\n\n");
    const set = subscribers.get(channel) ?? new Set();
    subscribers.set(channel, set);
    set.add(res);
    const ttl = setTimeout(
      () => res.end(),
      Math.max(v.claims.exp * 1000 - Date.now(), 0),
    );
    req.on("close", () => {
      clearTimeout(ttl);
      set.delete(res);
    });
    return;
  }
  res.writeHead(404).end();
}).listen(PORT, "0.0.0.0", () => console.log(`fake push on ${PORT}`));
