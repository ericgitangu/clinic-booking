import { beforeEach, describe, expect, it, vi } from "vitest";

const plain = vi.hoisted(() => vi.fn());
const dismiss = vi.hoisted(() => vi.fn());
const kinds = vi.hoisted(() => ({
  success: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));
const haptic = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({
  toast: Object.assign((...a: unknown[]) => plain(...a), { dismiss, ...kinds }),
}));
vi.mock("@clinic/ui/lib/haptics", () => ({ haptic }));

import { notify } from "@clinic/ui/lib/notify";
import { markToasterMounted } from "@clinic/ui/lib/toaster-gate";

beforeEach(() => vi.clearAllMocks());

describe("notify.quiet and notify.dismiss", () => {
  it("shows a plain toast under its id with no buzz", async () => {
    markToasterMounted();
    notify.quiet("Marked arrived", { id: "a" });
    await vi.waitFor(() =>
      expect(plain).toHaveBeenCalledWith("Marked arrived", { id: "a" }),
    );
    expect(haptic).not.toHaveBeenCalled();
  });

  it("dismisses a toast by its id", async () => {
    markToasterMounted();
    notify.dismiss("a");
    await vi.waitFor(() => expect(dismiss).toHaveBeenCalledWith("a"));
  });

  it.each(["success", "info", "warning"] as const)(
    "update(%s) re-shows a toast by id in that look, with no buzz",
    async (kind) => {
      markToasterMounted();
      notify.update(kind, "Marked arrived. Doctor emailed.", {
        id: "t",
        duration: 6000,
      });
      await vi.waitFor(() =>
        expect(kinds[kind]).toHaveBeenCalledWith(
          "Marked arrived. Doctor emailed.",
          { id: "t", duration: 6000 },
        ),
      );
      expect(haptic).not.toHaveBeenCalled();
    },
  );
});
