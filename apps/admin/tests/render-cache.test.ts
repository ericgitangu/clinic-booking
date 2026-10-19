import { describe, expect, it, vi } from "vitest";
import { memo, readKey } from "@/lib/render-cache";

describe("per-render read cache", () => {
  it("asks once for the same read made twice in one render", async () => {
    const store = new Map<string, Promise<unknown>>();
    const ask = vi.fn(async () => ({ ok: true }));
    const key = readKey(
      "opsToday",
      { sub: "s1", role: "owner" },
      { date: "2026-10-19" },
    );
    const [a, b] = await Promise.all([
      memo(key, ask, store),
      memo(key, ask, store),
    ]);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it("never shares a result between people or between different questions", async () => {
    const store = new Map<string, Promise<unknown>>();
    const ask = vi.fn(async () => Math.random());
    const owner = { sub: "s1", role: "owner" };
    const viewer = { sub: "s2", role: "viewer" };
    await memo(readKey("opsToday", owner, { date: "d1" }), ask, store);
    await memo(readKey("opsToday", viewer, { date: "d1" }), ask, store);
    await memo(readKey("opsToday", owner, { date: "d2" }), ask, store);
    await memo(readKey("opsKpis", owner, { date: "d1" }), ask, store);
    expect(ask).toHaveBeenCalledTimes(4);
  });

  it("a new render starts with an empty map", async () => {
    const ask = vi.fn(async () => 1);
    await memo("k", ask, new Map());
    await memo("k", ask, new Map());
    expect(ask).toHaveBeenCalledTimes(2);
  });
});
