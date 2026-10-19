import { describe, expect, it } from "vitest";
import {
  readSingleKeys,
  SINGLE_KEYS_KEY,
  writeSingleKeys,
} from "@/lib/shortcut-setting";

function fakeStore(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k: string) => data[k] ?? null,
    setItem: (k: string, v: string) => {
      data[k] = v;
    },
  };
}

describe("single-key shortcut setting", () => {
  it("is on until someone turns it off", () => {
    expect(readSingleKeys(fakeStore())).toBe(true);
    expect(readSingleKeys(fakeStore({ [SINGLE_KEYS_KEY]: "on" }))).toBe(true);
    expect(readSingleKeys(fakeStore({ [SINGLE_KEYS_KEY]: "off" }))).toBe(false);
  });

  it("remembers the choice", () => {
    const s = fakeStore();
    writeSingleKeys(false, s);
    expect(readSingleKeys(s)).toBe(false);
    writeSingleKeys(true, s);
    expect(readSingleKeys(s)).toBe(true);
  });

  it("keeps working when storage is blocked", () => {
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readSingleKeys(blocked)).toBe(true);
    expect(() => writeSingleKeys(false, blocked)).not.toThrow();
    expect(readSingleKeys(null)).toBe(true);
  });
});
