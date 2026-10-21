import { describe, expect, it } from "vitest";
import { zAuditEntry } from "@clinic/api/generated/zod.gen";
import { AUDIT_ACTION } from "@/lib/audit-labels";

describe("the audit trail labels", () => {
  it("names every action the API can return, and none shows a raw code", () => {
    const actions = zAuditEntry.shape.action.options;
    expect(Object.keys(AUDIT_ACTION).sort()).toEqual([...actions].sort());
    for (const [code, label] of Object.entries(AUDIT_ACTION))
      expect(label, code).not.toMatch(/_/);
  });
});
