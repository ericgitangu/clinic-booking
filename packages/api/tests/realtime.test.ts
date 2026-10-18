import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  StreamController,
  TokenError,
  createSseParser,
  type StreamStatus,
} from "../src/realtime";

// The stream under test is served by a small local HTTP server that speaks the push service's SSE
// format as observed in CI against the real service (contracts/events/README.md): a JWT as a Bearer
// header, frames "event: message" whose data is a JSON message with the payload as a JSON string,
// and a refused or expired token as an "event: error" frame on a 200 stream. It stands in for the
// third party only; the controller, parser and zod schema are the real ones.

const Event = z.object({
  kind: z.enum(["slot_taken", "slot_freed"]),
  seq: z.string(),
});
type Ev = z.infer<typeof Event>;

let server: Server;
let base = "";
let script: (auth: string | undefined) => string[] | "hold";
let held: Array<() => void> = [];

beforeEach(async () => {
  held = [];
  server = createServer((req, res) => {
    const plan = script(req.headers.authorization);
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (plan === "hold") {
      res.write(": open\n\n"); // send the headers now
      held.push(() => res.end());
      return;
    }
    for (const f of plan) res.write(f);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  held.forEach((h) => h());
  await new Promise((r) => server.close(r));
});

const msg = (id: string, payload: unknown) =>
  `event: message\ndata: ${JSON.stringify({ id, name: "slot_taken", data: JSON.stringify(payload) })}\n\n`;
const err = (code: number) =>
  `event: error\ndata: ${JSON.stringify({ message: "x", code, statusCode: 401 })}\n\n`;

function make(
  over: Partial<ConstructorParameters<typeof StreamController<Ev>>[0]> = {},
) {
  const events: Array<[Ev, string]> = [];
  const statuses: StreamStatus[] = [];
  let connected = 0;
  let minted = 0;
  const c = new StreamController<Ev>({
    getToken: async () => ({
      token: `t${minted++}`,
      streamUrl: `${base}/s`,
    }),
    schema: Event,
    onEvent: (e, id) => events.push([e, id]),
    onStatus: (s) => statuses.push(s),
    onConnected: () => connected++,
    shouldReconnect: () => true,
    backoff: { baseMs: 10, maxMs: 40 },
    refusedWaitMs: 5000,
    ...over,
  });
  return { c, events, statuses, connected: () => connected };
}
const until = async (f: () => boolean) => {
  for (let i = 0; i < 300 && !f(); i++)
    await new Promise((r) => setTimeout(r, 10));
  expect(f()).toBe(true);
};

describe("createSseParser", () => {
  it("assembles frames across chunk boundaries and reports comments", () => {
    const frames: unknown[] = [];
    const p = createSseParser((f) => frames.push(f));
    const enc = new TextEncoder();
    p.push(enc.encode(": hb\n\nevent: ping\nda"));
    p.push(enc.encode("ta: a\ndata: b\n\n"));
    expect(frames).toEqual([
      { kind: "comment", text: "hb" },
      { kind: "event", event: "ping", data: "a\nb", id: null },
    ]);
  });
});

describe("StreamController against the SSE format", () => {
  it("goes live, sends the token as a Bearer header and delivers valid events only", async () => {
    let auth: string | undefined;
    script = (a) => {
      auth = a;
      return [
        msg("1.1.1", { kind: "slot_taken", seq: "1.1.1" }),
        msg("1.2.0", { nope: true }), // not an event: dropped by the schema
        ": hb\n\n",
      ];
    };
    const { c, events, statuses, connected } = make({
      shouldReconnect: () => false,
    });
    c.start();
    await until(() => events.length === 1);
    expect(auth).toBe("Bearer t0");
    expect(events[0]).toEqual([{ kind: "slot_taken", seq: "1.1.1" }, "1.1.1"]);
    expect(statuses).toContain("live");
    expect(connected()).toBe(1);
    c.stop();
  });

  it("mints a new token and reconnects after a token-expiry frame (40142), when allowed", async () => {
    let n = 0;
    script = () => (n++ === 0 ? [err(40142)] : "hold");
    const { c, statuses } = make();
    c.start();
    await until(() => c.mintCount === 2 && statuses.at(-1) === "live");
    c.stop();
  });

  it("does not mint again when the page may not reconnect (hidden, idle, no new input)", async () => {
    script = () => [err(40142)];
    const { c, statuses } = make({ shouldReconnect: () => false });
    c.start();
    await until(() => statuses.at(-1) === "polling");
    await new Promise((r) => setTimeout(r, 120));
    expect(c.mintCount).toBe(1);
    c.stop();
  });

  it("treats 40160 as refused and does not retry", async () => {
    script = () => [err(40160)];
    const { c, statuses } = make();
    c.start();
    await until(() => statuses.at(-1) === "refused");
    await new Promise((r) => setTimeout(r, 120));
    expect(c.mintCount).toBe(1);
    c.stop();
  });

  it("backs off on a service error frame and says polling", async () => {
    script = () => [err(50000)];
    const { c, statuses } = make();
    c.start();
    await until(() => c.mintCount >= 3);
    expect(statuses).toContain("polling");
    c.stop();
  });

  it("is refused when the token endpoint rate limits, and leaves it alone", async () => {
    script = () => "hold";
    const { c, statuses } = make({
      getToken: async () => {
        throw new TokenError("rate_limited", 30_000);
      },
    });
    c.start();
    await until(() => statuses.at(-1) === "refused");
    await new Promise((r) => setTimeout(r, 100));
    expect(c.mintCount).toBe(1);
    c.stop();
  });

  it("says polling, not refused, when push is switched off (503)", async () => {
    script = () => "hold";
    const { c, statuses } = make({
      getToken: async () => {
        throw new TokenError("unavailable");
      },
    });
    c.start();
    await until(() => statuses.at(-1) === "polling");
    c.stop();
    expect(statuses).not.toContain("refused");
  });

  it("stop() closes the stream and reports off", async () => {
    script = () => "hold";
    const { c, statuses } = make();
    c.start();
    await until(() => statuses.at(-1) === "live");
    c.stop();
    expect(statuses.at(-1)).toBe("off");
  });
});
