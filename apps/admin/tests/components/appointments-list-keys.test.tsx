import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));
vi.mock("@/lib/actions", () => ({
  cancelAppointment: async () => ({ ok: true, message: "" }),
  rescheduleAppointment: async () => ({ ok: true, message: "" }),
  loadSlots: async () => ({ ok: true, slots: [] }),
}));

import { AppointmentsList } from "@/components/appointments-list";
import type { AdminAppointment } from "@clinic/api/generated";

const row = (id: string, minute: number): AdminAppointment =>
  ({
    id,
    doctor_id: "d1",
    doctor_name: "Dr One",
    patient_name: `Patient ${id}`,
    starts_at: new Date(Date.UTC(2098, 11, 31, 10, minute)).toISOString(),
    ends_at: new Date(Date.UTC(2098, 11, 31, 10, minute + 15)).toISOString(),
    status: "booked",
    attendance: null,
    staff_locked: false,
    view: "full",
  }) as unknown as AdminAppointment;

// Every element carrying a key, in tree order, for one container (a <tbody> or the card <ul>).
function keysUnder(node: ReactNode, tag: (el: ReactElement) => boolean) {
  const out: string[][] = [];
  const walk = (n: ReactNode) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!isValidElement(n)) return;
    const el = n as ReactElement<{ children?: ReactNode }>;
    if (tag(el)) {
      const kids: ReactNode[] = [];
      const collect = (c: ReactNode) => {
        if (Array.isArray(c)) return c.forEach(collect);
        if (isValidElement(c) && c.key !== null) kids.push(String(c.key));
      };
      collect(el.props.children);
      out.push(kids.map(String));
    }
    walk(el.props.children);
  };
  walk(node);
  return out;
}

const render = (items: AdminAppointment[]) =>
  AppointmentsList({
    items,
    canAct: true,
    status: "all",
    nextHref: null,
    firstHref: null,
  });

describe("appointment rows keep their identity across a list update", () => {
  const ids = ["a", "b", "c"].map((x) => `id-${x}`);

  it("keys every row and card by appointment id, never by position", () => {
    const tree = render(ids.map((id, i) => row(id, i)));
    const groups = keysUnder(tree, keyed);
    const flat = groups.flat();
    for (const id of ids) expect(flat.filter((k) => k === id).length).toBe(2);
    expect(flat.some((k) => /^\d+$/.test(k))).toBe(false);
  });

  it("gives a row the same key when rows are inserted above and below it", () => {
    const before = keysFor(render([row("id-b", 1)]));
    const after = keysFor(
      render([row("id-new-top", 0), row("id-b", 1), row("id-new-end", 2)]),
    );
    expect(before).toEqual(["id-b"]);
    expect(after).toEqual(["id-new-top", "id-b", "id-new-end"]);
    // id-b is the same React child in both renders, wherever it now sits in the list.
    expect(after).toContain(before[0]);
  });
});

function keyed(el: ReactElement) {
  const c = (el as ReactElement<{ children?: ReactNode }>).props.children;
  return Array.isArray(c) && c.some((x) => isValidElement(x) && x.key !== null);
}

function keysFor(tree: ReactNode): string[] {
  const groups = keysUnder(tree, keyed);
  // First keyed group is the table body's rows.
  return groups[0] ?? [];
}
