// STAND-IN for Resend's HTTP API (api.resend.com), the one third party in the email tests. A real
// HTTP server the app really calls (the Resend SDK is pointed here with RESEND_BASE_URL); nothing
// is mocked in the app. It records what it was sent and behaves like Resend where it matters here:
//   - 401 without the bearer key;
//   - the same Idempotency-Key with the same payload returns the first answer and sends nothing new,
//     and the same key with a different payload is a 409 (as Resend documents);
//   - it can be told to refuse the emails to one recipient, every time or only the next N times, to
//     test that a refused email never fails a booking, never marks a reminder as sent, and that a
//     passing failure is retried.
//   - it can be told to accept the emails to one recipient and never answer them (the connection is
//     held open), to test that a provider that hangs never delays a booking.
// Control: POST /_hang {to} and POST /_hang {to, clear: true}; GET /_sent, POST /_fail {to, status, times?} and POST /_fail {to, clear: true} to clear that recipient.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.RESEND_STANDIN_PORT ?? 3198);
// A throwaway key, built at run time so it does not look like a committed secret.
const KEY =
  process.env.RESEND_API_KEY ?? ["re", "e2e", "standin", "key"].join("_"); // ggignore

const sent = []; // accepted emails
const attempts = []; // every request that reached /emails, accepted or not
const byKey = new Map(); // idempotency key -> { payload, id }
const hanging = new Set(); // recipients whose requests are accepted and never answered
const failing = new Map(); // recipient -> { status, times } (times: null = every time)

async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString();
  try {
    return JSON.parse(text || "{}");
  } catch {
    return {};
  }
}

const json = (res, status, obj) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
};

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "GET" && url.pathname === "/_health")
    return json(res, 200, { ok: true });
  if (req.method === "GET" && url.pathname === "/_sent")
    return json(res, 200, { sent, attempts });
  if (req.method === "POST" && url.pathname === "/_fail") {
    const b = await body(req);
    if (b.to === null) failing.clear();
    else if (b.clear) failing.delete(String(b.to).toLowerCase());
    else
      failing.set(String(b.to).toLowerCase(), {
        status: Number(b.status ?? 500),
        times: b.times ?? null,
      });
    return json(res, 200, { failing: [...failing] });
  }
  if (req.method === "POST" && url.pathname === "/_hang") {
    const b = await body(req);
    const to = String(b.to).toLowerCase();
    if (b.clear) hanging.delete(to);
    else hanging.add(to);
    return json(res, 200, { hanging: [...hanging] });
  }
  if (req.method === "POST" && url.pathname === "/emails") {
    if (req.headers.authorization !== `Bearer ${KEY}`) {
      return json(res, 401, {
        statusCode: 401,
        name: "missing_api_key",
        message: "Missing API key",
      });
    }
    const payload = await body(req);
    const idem = req.headers["idempotency-key"];
    const to = (
      Array.isArray(payload.to) ? payload.to[0] : (payload.to ?? "")
    ).toLowerCase();
    attempts.push({ to, key: idem ?? null, subject: payload.subject });
    if (hanging.has(to)) return; // accepted, never answered: the connection stays open
    const fail = failing.get(to);
    if (fail) {
      if (fail.times !== null && --fail.times <= 0) failing.delete(to);
      const status = fail.status;
      return json(res, status, {
        statusCode: status,
        name: "application_error",
        message: "refused for the test",
      });
    }
    if (idem && byKey.has(idem)) {
      const first = byKey.get(idem);
      if (JSON.stringify(first.payload) !== JSON.stringify(payload)) {
        return json(res, 409, {
          statusCode: 409,
          name: "invalid_idempotent_request",
          message: "Same key, different payload",
        });
      }
      return json(res, 200, { id: first.id });
    }
    const id = randomUUID();
    if (idem) byKey.set(idem, { payload, id });
    sent.push({
      id,
      to,
      from: payload.from,
      reply_to: payload.reply_to ?? payload.replyTo ?? null,
      subject: payload.subject,
      text: payload.text,
      html: payload.html,
      idempotency_key: idem ?? null,
    });
    return json(res, 200, { id });
  }
  return json(res, 404, {
    statusCode: 404,
    name: "not_found",
    message: "no such route",
  });
}).listen(PORT, "127.0.0.1", () => console.log(`resend stand-in on ${PORT}`));
