import { describe, expect, it } from "vitest";
import {
  nextHalfHourMoveSql,
  noFreeNextHalfHourMessage,
} from "../e2e/support/slot-sql";

const ID = "11111111-2222-3333-4444-555555555555";

describe("the next-half-hour move", () => {
  const sql = nextHalfHourMoveSql(ID);

  it("only picks a doctor with no booked visit on that start", () => {
    expect(sql).toMatch(/NOT EXISTS/);
    expect(sql).toMatch(/o\.status = 'booked'/);
    expect(sql).toMatch(/o\.starts_at = slot\.s/);
    // the visit being moved does not count against its own new slot
    expect(sql).toContain(`o.id <> '${ID}'`);
  });

  it("moves the doctor along with the start, so the pick is never the visit's own busy doctor", () => {
    expect(sql).toMatch(/doctor_id = cand\.doctor_id/);
    expect(sql).toMatch(/starts_at = cand\.s/);
  });

  it("stays on the 20 to 50 minute grid point and only touches a booked visit", () => {
    expect(sql).toContain("now() + interval '50 minutes'");
    expect(sql).toContain(`a.id = '${ID}' AND a.status = 'booked'`);
  });

  it("prefers a doctor who works that half hour, then the end of the alphabet", () => {
    expect(sql).toMatch(/working_hours/);
    expect(sql).toMatch(/ORDER BY[\s\S]*DESC,\s*d\.full_name DESC/);
  });

  it("rejects an id that is not a uuid before it reaches SQL", () => {
    expect(() => nextHalfHourMoveSql("1' OR '1'='1")).toThrow(/uuid/);
  });

  it("explains a failed search in words", () => {
    const m = noFreeNextHalfHourMessage(ID, "UPDATE 0");
    expect(m).toContain(ID);
    expect(m).toMatch(/every doctor/i);
    expect(m).toMatch(/already has a booked visit/i);
    expect(m).toMatch(/not booked/i);
    expect(m).toContain("UPDATE 0");
  });
});
