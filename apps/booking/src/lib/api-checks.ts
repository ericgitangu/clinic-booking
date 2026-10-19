// The landing page's "Run the API checks" panel. It runs requests from the reviewer collection
// (docs/api/clinic-booking.postman_collection.json, built from the contract by
// scripts/api_collection.mjs) against this site's /api, from the browser.
//
// Nothing here restates what a response should be. The method, path, headers, body, expected
// status, problem code, response schema and the names of the assertions all come from the
// collection when it is loaded. What is written here is how to run each named assertion without
// Postman's sandbox (ASSERTIONS below) and how to compute the values the pre-request scripts
// compute. tests/api-checks.test.ts fails when the collection gains an assertion, a pre-request
// value or a captured variable on a planned request that this file cannot run, so the two cannot
// drift apart quietly.
//
// Two plans:
//   read   every GET request whose inputs a read can supply. It never sends anything but GET.
//   write  read, plus the requests in WRITE_STEPS: two patients (names only), one booking, its
//          replay, the double booking, a booking too soon, and the cancel. Anything the run books
//          and does not cancel is cancelled at the end.

export type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  const?: unknown;
  pattern?: string;
  anyOf?: JsonSchema[];
};

export type Check = {
  folder: string;
  name: string;
  method: string;
  // The collection's host variable: baseUrl (reads), writeBaseUrl (writes), or another a local
  // stack sets up (folder 08). The page sends both of the first two to /api.
  host: string;
  path: string;
  query: [string, string][];
  headers: [string, string][];
  body: string | null;
  status: number;
  code: string | null;
  schema: JsonSchema | null;
  // Names of the collection's pm.test assertions, in order.
  tests: string[];
  // Variables the pre-request script sets, and the response fields the test script captures.
  sets: string[];
  // `when found` captures are kept only if the slot search found a day.
  captures: { name: string; path: (string | number)[]; whenFound: boolean }[];
  prerequest: string;
};

export type Extracted =
  { ok: true; checks: Check[] } | { ok: false; error: string };

// The collection is Postman v2.1. Only the fields used here are typed.
type PmScript = { listen: string; script: { exec: string[] } };
type PmRequest = {
  name: string;
  event?: PmScript[];
  request: {
    method: string;
    header?: { key: string; value: string }[];
    url: { raw: string; query?: { key: string; value: string }[] };
    body?: { raw?: string };
  };
};
export type PmCollection = { item: { name: string; item: PmRequest[] }[] };

const script = (r: PmRequest, listen: string) =>
  r.event?.find((e) => e.listen === listen)?.script.exec.join("\n") ?? "";

// A value a test script stores for later requests: `set("x", <root><accessors>)`.
const CAPTURE =
  /collectionVariables\.set\("(\w+)", (found \? )?(?:String\()?(pm\.response\.json\(\)|appt|body|items)((?:\.\w+|\[\d+\])*)/g;

function capturePath(root: string, accessors: string): (string | number)[] {
  const parts = [...accessors.matchAll(/\.(\w+)|\[(\d+)\]/g)].map((m) =>
    m[1] !== undefined ? m[1] : Number(m[2]),
  );
  return root === "items" ? ["items", ...parts] : parts;
}

export function extractChecks(collection: PmCollection): Extracted {
  const checks: Check[] = [];
  for (const folder of collection.item) {
    for (const r of folder.item) {
      const tests = script(r, "test");
      const status = /pm\.test\("status is (\d{3})"/.exec(tests);
      if (!status) {
        return {
          ok: false,
          error: `${folder.name} / ${r.name}: no "status is" assertion`,
        };
      }
      const host = /^\{\{(\w+)\}\}/.exec(r.request.url.raw);
      if (!host) {
        return {
          ok: false,
          error: `${folder.name} / ${r.name}: no host variable`,
        };
      }
      const schemaLine = /^const schema = (.*);$/m.exec(tests);
      const pre = script(r, "prerequest");
      checks.push({
        folder: folder.name,
        name: r.name,
        method: r.request.method,
        host: host[1],
        path: r.request.url.raw.slice(host[0].length).split("?")[0],
        query: (r.request.url.query ?? []).map((q) => [q.key, q.value]),
        headers: (r.request.header ?? []).map((h) => [h.key, h.value]),
        body: r.request.body?.raw ?? null,
        status: Number(status[1]),
        code: /pm\.test\("problem code is (\w+)"/.exec(tests)?.[1] ?? null,
        schema: schemaLine ? (JSON.parse(schemaLine[1]) as JsonSchema) : null,
        tests: [...tests.matchAll(/pm\.test\("([^"]+)"/g)].map((m) => m[1]),
        sets: [
          ...new Set(
            [...pre.matchAll(/collectionVariables\.set\("(\w+)"/g)].map(
              (m) => m[1],
            ),
          ),
        ],
        captures: [...tests.matchAll(CAPTURE)].map((m) => ({
          name: m[1],
          path: capturePath(m[3], m[4]),
          whenFound: m[2] !== undefined,
        })),
        prerequest: pre,
      });
    }
  }
  return { ok: true, checks };
}

// ---- plans ------------------------------------------------------------------------------

// Variables a run of reads can fill: from GET responses or from the clock.
const READ_VARS = new Set(["doctorId", "slotDay", "farDay"]);
const WRITE_VARS = new Set([
  ...READ_VARS,
  "patientId",
  "otherPatientId",
  "appointmentId",
  "idempotencyKey",
  "soonStart",
]);

// The writes the page may send, by what the request is rather than its display name: method, path,
// expected outcome and the variables it sends. A collection request that books something the run
// would not cancel cannot match one of these.
export const WRITE_STEPS = [
  "POST /patients -> 201 []",
  "POST /appointments -> 201 [doctorId,idempotencyKey,patientId,slotStart]",
  "POST /appointments -> 409 SLOT_TAKEN [doctorId,otherPatientId,slotStart]",
  "POST /appointments -> 422 BOOKING_TOO_SOON [doctorId,otherPatientId,soonStart]",
  "PATCH /appointments/{{appointmentId}}/cancel -> 200 []",
] as const;

const VAR = /\{\{\s*([$\w]+)\s*\}\}/g;

export function variablesOf(c: Check): string[] {
  const text = JSON.stringify([c.path, c.query, c.headers, c.body]);
  return [...new Set([...text.matchAll(VAR)].map((m) => m[1]))].filter(
    (v) => !v.startsWith("$"),
  );
}

export function signature(c: Check): string {
  const sent = variablesOf(c)
    .filter((v) => !c.path.includes(`{{${v}}}`))
    .sort();
  return `${c.method} ${c.path} -> ${c.status}${c.code ? " " + c.code : ""} [${sent.join(",")}]`;
}

export type Mode = "read" | "write";

export function plan(checks: Check[], mode: Mode): Check[] {
  return checks.filter((c) => {
    if (c.host !== "baseUrl" && c.host !== "writeBaseUrl") return false;
    const inputs = variablesOf(c).filter((v) => !c.sets.includes(v));
    if (c.method === "GET") {
      const known = mode === "read" ? READ_VARS : WRITE_VARS;
      return inputs.every((v) => known.has(v));
    }
    return (
      mode === "write" &&
      (WRITE_STEPS as readonly string[]).includes(signature(c))
    );
  });
}

// ---- schema -----------------------------------------------------------------------------

// The subset of JSON Schema the collection's schemas use (tests/api-checks.test.ts lists the
// keywords and fails on a new one). Returns the first mismatch, or null.
export function validate(
  schema: JsonSchema,
  value: unknown,
  at = "body",
): string | null {
  if (schema.anyOf) {
    const fits = schema.anyOf.some((s) => validate(s, value, at) === null);
    if (!fits) return `${at} matches none of the allowed shapes`;
  }
  if (schema.const !== undefined && value !== schema.const) {
    return `${at} is ${JSON.stringify(value)}, not ${JSON.stringify(schema.const)}`;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    return `${at} is ${JSON.stringify(value)}, not one of the allowed values`;
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => isType(t, value))) {
      return `${at} is not ${types.join(" or ")}`;
    }
  }
  if (schema.pattern !== undefined && typeof value === "string") {
    if (!new RegExp(schema.pattern, "u").test(value)) {
      return `${at} does not match ${schema.pattern}`;
    }
  }
  if (isObject(value)) {
    for (const key of schema.required ?? []) {
      if (!(key in value)) return `${at}.${key} is missing`;
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in value) {
        const err = validate(sub, value[key], `${at}.${key}`);
        if (err) return err;
      }
    }
  }
  if (Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i++) {
      const err = validate(schema.items, value[i], `${at}[${i}]`);
      if (err) return err;
    }
  }
  return null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isType(type: string, v: unknown): boolean {
  switch (type) {
    case "null":
      return v === null;
    case "array":
      return Array.isArray(v);
    case "object":
      return isObject(v);
    case "integer":
      return Number.isInteger(v);
    case "number":
      return typeof v === "number";
    default:
      return typeof v === type;
  }
}

// ---- assertions -------------------------------------------------------------------------

type Ctx = {
  check: Check;
  status: number;
  headers: Headers;
  // A parsed JSON body is whatever the server sent; each assertion narrows what it reads.
  body: unknown;
  vars: Record<string, string>;
  sentBody: unknown;
  slotSearchFound: boolean;
};

const at = (v: unknown, path: (string | number)[]): unknown =>
  path.reduce<unknown>(
    (cur, key) =>
      cur !== null && typeof cur === "object"
        ? (cur as Record<string | number, unknown>)[key]
        : undefined,
    v,
  );

const ms = (iso: unknown) =>
  typeof iso === "string" ? new Date(iso).getTime() : NaN;
const fail = (ok: boolean, why: string) => (ok ? null : why);

// How each named pm.test in the collection is run here. The key is matched against the test's
// name; numbers in the name (a status, a lead time) are read from the name, not restated.
const ASSERTIONS: [RegExp, (c: Ctx, m: RegExpMatchArray) => string | null][] = [
  [
    /^status is (\d{3})$/,
    (c, m) => fail(c.status === Number(m[1]), `status was ${c.status}`),
  ],
  [
    /^content-type is (application\/[\w+]+)$/,
    (c, m) => {
      const type = c.headers.get("content-type") ?? "";
      return fail(
        type.startsWith(m[1]),
        `content-type was ${type || "missing"}`,
      );
    },
  ],
  [
    /^problem code is (\w+)$/,
    (c, m) =>
      fail(
        at(c.body, ["code"]) === m[1],
        `code was ${String(at(c.body, ["code"]))}`,
      ),
  ],
  [
    /^problem status matches the response$/,
    (c) => fail(at(c.body, ["status"]) === c.status, "problem status differs"),
  ],
  [
    /^problem carries type, title, instance and request_id$/,
    (c) => {
      const missing = ["type", "title", "instance", "request_id"].filter(
        (k) => {
          const v = at(c.body, [k]);
          return typeof v !== "string" || v === "";
        },
      );
      return fail(missing.length === 0, `missing ${missing.join(", ")}`);
    },
  ],
  [
    /^body matches the contract schema$/,
    (c) =>
      c.check.schema
        ? validate(c.check.schema, c.body)
        : "no schema in the collection",
  ],
  [
    /^errors\[\] names ([\w.-]+)$/,
    (c, m) => {
      const errors = at(c.body, ["errors"]);
      const locs = Array.isArray(errors)
        ? errors.map((e) => {
            const loc = at(e, ["loc"]);
            return Array.isArray(loc) ? loc.join(".") : "";
          })
        : [];
      return fail(
        locs.includes(m[1]),
        `errors[] has ${locs.join(", ") || "nothing"}`,
      );
    },
  ],
  [
    /^status is ok$/,
    (c) => fail(at(c.body, ["status"]) === "ok", "status field is not ok"),
  ],
  [
    /^catalogue lists both (one-hour|lead-time) codes$/,
    (c) => {
      const codes = Array.isArray(c.body)
        ? c.body.map((p) => at(p, ["code"]))
        : [];
      return fail(
        ["BOOKING_TOO_SOON", "CHANGE_TOO_LATE"].every((k) => codes.includes(k)),
        "a one-hour code is missing",
      );
    },
  ],
  [
    /^it documents (\w+) as a (\d{3})$/,
    (c, m) =>
      fail(
        at(c.body, ["code"]) === m[1] &&
          at(c.body, ["status"]) === Number(m[2]),
        `documents ${String(at(c.body, ["code"]))} as ${String(at(c.body, ["status"]))}`,
      ),
  ],
  [
    /^at least one doctor$/,
    (c) => {
      const items = at(c.body, ["items"]);
      return fail(Array.isArray(items) && items.length > 0, "no doctors");
    },
  ],
  [
    /^every doctor has working hours$/,
    (c) => {
      const items = at(c.body, ["items"]);
      const ok =
        Array.isArray(items) &&
        items.every((d) => {
          const hours = at(d, ["working_hours"]);
          return Array.isArray(hours) && hours.length > 0;
        });
      return fail(ok, "a doctor has no working hours");
    },
  ],
  [
    /^it is the doctor asked for$/,
    (c) => fail(at(c.body, ["id"]) === c.vars.doctorId, "a different doctor"),
  ],
  [
    /^it is the day asked for$/,
    (c) => fail(at(c.body, ["date"]) === c.vars.slotDay, "a different day"),
  ],
  [
    /^no slot starts within (\d+) minutes$/,
    (c, m) => {
      // Against the server's clock (the Date header, whole seconds), as the collection does.
      const now =
        Date.parse(c.headers.get("date") ?? "") || Date.now() - 120_000;
      const earliest = now + Number(m[1]) * 60_000 - 2000;
      const slots = at(c.body, ["slots"]);
      const early = Array.isArray(slots)
        ? slots.find((s) => ms(at(s, ["starts_at"])) < earliest)
        : undefined;
      return fail(
        early === undefined,
        `${String(at(early, ["starts_at"]))} is too soon`,
      );
    },
  ],
  [
    /^a day in the next (\d+) has two free slots/,
    (c, m) =>
      fail(c.slotSearchFound, `no day in the next ${m[1]} has two free slots`),
  ],
  [
    /^booked at the slot asked for$/,
    (c) => {
      const length =
        ms(at(c.body, ["ends_at"])) - ms(at(c.body, ["starts_at"]));
      return fail(
        at(c.body, ["status"]) === "booked" &&
          ms(at(c.body, ["starts_at"])) === ms(c.vars.slotStart) &&
          length === Number(c.vars.slotMinutes) * 60_000,
        "not booked at that slot",
      );
    },
  ],
  [
    /^Location points at the appointment$/,
    (c) => {
      // The site's proxy puts /api in front of the API's own Location; both name the appointment.
      const location = c.headers.get("location") ?? "";
      const id = String(at(c.body, ["id"]));
      return fail(
        location.replace(/^\/api(?=\/)/, "") === `/appointments/${id}`,
        `Location was ${location || "missing"}`,
      );
    },
  ],
  [
    /^not marked as a replay$/,
    (c) => fail(!c.headers.has("idempotent-replayed"), "marked as a replay"),
  ],
  [
    /^same appointment returned$/,
    (c) =>
      fail(
        at(c.body, ["id"]) === c.vars.appointmentId,
        "a different appointment",
      ),
  ],
  [
    /^Idempotent-Replayed: true$/,
    (c) =>
      fail(
        c.headers.get("idempotent-replayed") === "true",
        "no Idempotent-Replayed: true",
      ),
  ],
  [
    /^it is the booked appointment$/,
    (c) =>
      fail(
        at(c.body, ["id"]) === c.vars.appointmentId &&
          at(c.body, ["status"]) === "booked",
        "not the booked appointment",
      ),
  ],
  [
    /^the replay made no second booking$/,
    (c) => {
      const items = at(c.body, ["items"]);
      const ids = Array.isArray(items) ? items.map((a) => at(a, ["id"])) : [];
      return fail(
        ids.length === 1 && ids[0] === c.vars.appointmentId,
        `the patient has ${ids.length} appointments`,
      );
    },
  ],
  [
    /^cancelled with the reason given$/,
    (c) =>
      fail(
        at(c.body, ["status"]) === "cancelled" &&
          at(c.body, ["cancellation_reason"]) === at(c.sentBody, ["reason"]) &&
          typeof at(c.body, ["cancelled_at"]) === "string",
        "not cancelled with that reason",
      ),
  ],
];

export function assertionFor(name: string) {
  for (const [pattern, run] of ASSERTIONS) {
    const m = name.match(pattern);
    if (m) return (c: Ctx) => run(c, m);
  }
  return null;
}

// ---- values the pre-request scripts compute -----------------------------------------------

const UTC_DAY = (days: number, now: number) =>
  new Date(now + days * 86_400_000).toISOString().slice(0, 10);

// The `set("name", ...)` shapes the collection's pre-request scripts use: the pattern, which group
// holds the variable's name, and how to compute the value here.
const PREREQUEST: [
  RegExp,
  number,
  (m: RegExpMatchArray, now: number) => string,
][] = [
  [
    /collectionVariables\.set\("(\w+)", new Date\(Date\.now\(\) \+ (\d+) \* 86400000\)\.toISOString\(\)\.slice\(0, 10\)\)/g,
    1,
    (m, now) => UTC_DAY(Number(m[2]), now),
  ],
  [
    /new Date\(Date\.now\(\) \+ (\d+) \* 60000\);\s*t\.setUTCSeconds\(0, 0\);\s*pm\.collectionVariables\.set\("(\w+)", t\.toISOString\(\)\)/g,
    2,
    (m, now) => {
      const t = new Date(now + Number(m[1]) * 60_000);
      t.setUTCSeconds(0, 0);
      return t.toISOString();
    },
  ],
  [
    /collectionVariables\.set\("(\w+)", "([\w-]*)" \+ pm\.variables\.replaceIn\("\{\{\$guid\}\}"\)\)/g,
    1,
    (m) => m[2] + crypto.randomUUID(),
  ],
];

function prerequestValues(pre: string, now: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [pattern, nameGroup, value] of PREREQUEST) {
    for (const m of pre.matchAll(pattern)) out[m[nameGroup]] = value(m, now);
  }
  return out;
}

// The availability request's pre-request asks one day after another, from tomorrow, for a day with
// two free slots (pm.sendRequest), up to a limit it states.
const slotSearchDays = (pre: string): number | null =>
  /pm\.sendRequest/.test(pre)
    ? Number(/if \(n > (\d+)\) return/.exec(pre)?.[1] ?? NaN) || null
    : null;

// Variables the pre-request of a planned request sets that this file knows how to compute.
export function computable(c: Check): string[] {
  const known = Object.keys(prerequestValues(c.prerequest, 0));
  if (slotSearchDays(c.prerequest)) known.push("slotDay", "slotSearch");
  return c.sets.filter((s) => known.includes(s));
}

// ---- running ----------------------------------------------------------------------------

export type Outcome = {
  check: Check;
  state: "pass" | "fail" | "skip";
  got: number | null;
  assertions: { name: string; error: string | null }[];
  // What was sent, after the variables were filled in (absent for a skipped request).
  url?: string;
  note?: string;
};

export type RunOptions = {
  mode: Mode;
  base: string; // "/api"
  fetch: typeof fetch;
  now?: () => number;
  onOutcome?: (o: Outcome) => void;
};

const FIRST_NAMES = ["Amina", "Baraka", "Chebet", "Juma", "Wanjiru", "Otieno"];

// A sent body never carries a way to reach a person, so no run sends an email or a text.
const CONTACT_FIELDS = ["email", "phone"];

function fill(text: string, vars: Record<string, string>): string {
  return text.replace(VAR, (_, name: string) => {
    if (name === "$randomFirstName")
      return FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)];
    if (name === "$guid") return crypto.randomUUID();
    return vars[name] ?? "";
  });
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function run(
  checks: Check[],
  opts: RunOptions,
): Promise<Outcome[]> {
  const now = opts.now ?? Date.now;
  const vars: Record<string, string> = {};
  const outcomes: Outcome[] = [];
  // Appointments this run booked, with the last status seen, so none is left booked.
  const booked = new Map<string, string>();
  let slotSearchFound = false;

  const send = async (method: string, url: string, init: RequestInit = {}) => {
    if (opts.mode === "read" && method !== "GET") {
      throw new Error(`a read-only run tried to send ${method} ${url}`);
    }
    return opts.fetch(opts.base + url, { ...init, method, cache: "no-store" });
  };

  const emit = (o: Outcome) => {
    outcomes.push(o);
    opts.onOutcome?.(o);
  };

  for (const check of plan(checks, opts.mode)) {
    Object.assign(vars, prerequestValues(check.prerequest, now()));
    const searchDays = slotSearchDays(check.prerequest);
    if (searchDays) {
      slotSearchFound = false;
      vars.slotDay = UTC_DAY(1, now());
      for (let n = 1; n <= searchDays; n++) {
        const res = await send(
          "GET",
          `/doctors/${vars.doctorId}/availability?date=${UTC_DAY(n, now())}`,
        );
        const slots = at(await readJson(res), ["slots"]);
        if (res.ok && Array.isArray(slots) && slots.length >= 2) {
          vars.slotDay = UTC_DAY(n, now());
          slotSearchFound = true;
          break;
        }
      }
    }

    const missing = variablesOf(check).filter((v) => !vars[v]);
    if (missing.length) {
      emit({
        check,
        state: "skip",
        got: null,
        assertions: [],
        note: `needs ${missing.join(", ")} from an earlier step`,
      });
      continue;
    }

    const path = fill(check.path, vars);
    const query = check.query.map(
      ([k, v]) =>
        `${encodeURIComponent(k)}=${encodeURIComponent(fill(v, vars))}`,
    );
    const url = path + (query.length ? "?" + query.join("&") : "");
    const body = check.body === null ? null : fill(check.body, vars);
    const sentBody: unknown = body === null ? null : JSON.parse(body);
    const contact = CONTACT_FIELDS.filter(
      (f) => at(sentBody, [f]) !== undefined,
    );
    if (contact.length) {
      emit({
        check,
        state: "skip",
        got: null,
        assertions: [],
        note: `not sent: the body has ${contact.join(", ")}`,
      });
      continue;
    }

    let res: Response;
    try {
      res = await send(check.method, url, {
        headers: Object.fromEntries(
          check.headers.map(([k, v]) => [k, fill(v, vars)]),
        ),
        body: body ?? undefined,
      });
    } catch (err) {
      emit({
        check,
        state: "fail",
        got: null,
        assertions: [],
        url,
        note: `no response: ${String(err)}`,
      });
      continue;
    }
    const json = await readJson(res);
    if (check.path.startsWith("/appointments") && res.ok) {
      const id = at(json, ["id"]);
      const status = at(json, ["status"]);
      if (
        typeof id === "string" &&
        typeof status === "string" &&
        (check.method === "POST" || booked.has(id))
      ) {
        booked.set(id, status);
      }
    }

    const ctx: Ctx = {
      check,
      status: res.status,
      headers: res.headers,
      body: json,
      vars,
      sentBody,
      slotSearchFound,
    };
    const assertions = check.tests.map((name) => {
      const assertion = assertionFor(name);
      return {
        name,
        error: assertion
          ? assertion(ctx)
          : "this page cannot run this assertion",
      };
    });
    for (const { name, path: from, whenFound } of check.captures) {
      const value = at(json, from);
      if (whenFound && !slotSearchFound) vars[name] = "";
      else if (value !== undefined && value !== null)
        vars[name] = String(value);
    }
    emit({
      check,
      state: assertions.every((a) => a.error === null) ? "pass" : "fail",
      got: res.status,
      assertions,
      url,
      note:
        res.status === 429
          ? `rate limited: try again in ${res.headers.get("retry-after") ?? "a minute"} s`
          : undefined,
    });
  }

  // A step that failed after the booking would leave it booked: cancel whatever is still booked.
  for (const [id, status] of booked) {
    if (status === "cancelled") continue;
    const res = await send("PATCH", `/appointments/${id}/cancel`, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reason: "Clean-up after the landing page's API checks",
      }),
    }).catch(() => null);
    emit({
      check: { ...CLEANUP, path: `/appointments/${id}/cancel` },
      url: `/appointments/${id}/cancel`,
      state: res?.ok ? "pass" : "fail",
      got: res?.status ?? null,
      assertions: [],
      note: res?.ok
        ? "a booking this run left booked is now cancelled"
        : "could not cancel a booking this run made",
    });
  }
  return outcomes;
}

const CLEANUP: Check = {
  folder: "Clean-up",
  name: "Cancel what the run left booked",
  method: "PATCH",
  host: "writeBaseUrl",
  path: "",
  query: [],
  headers: [],
  body: null,
  status: 200,
  code: null,
  schema: null,
  tests: [],
  sets: [],
  captures: [],
  prerequest: "",
};

// Loaded when a run starts, so the landing page itself carries none of it. The file is the one in
// docs/api/ that newman runs; nothing copies it.
export async function loadCollection(): Promise<PmCollection> {
  const mod =
    await import("../../../../docs/api/clinic-booking.postman_collection.json");
  return mod.default as unknown as PmCollection;
}
