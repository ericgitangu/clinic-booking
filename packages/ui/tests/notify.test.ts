import { beforeEach, describe, expect, it, vi } from "vitest";

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}));
const haptic = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast }));
vi.mock("@clinic/ui/lib/haptics", () => ({ haptic }));

import { notify } from "@clinic/ui/lib/notify";
import {
  markToasterMounted,
  onToasterRequested,
} from "@clinic/ui/lib/toaster-gate";

beforeEach(() => vi.clearAllMocks());

describe("notify", () => {
  it("asks for the toaster, buzzes at once, and shows the toast only when the toaster is on the page", async () => {
    const asked = vi.fn();
    onToasterRequested(asked);
    notify.success("Early");
    expect(asked).toHaveBeenCalled();
    expect(haptic).toHaveBeenCalledWith("success");
    await Promise.resolve();
    expect(toast.success).not.toHaveBeenCalled();
    markToasterMounted();
    await vi.waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Early", undefined),
    );
  });

  it.each([
    ["success", "success", "success"],
    ["info", "info", "info"],
    ["warning", "warning", "warning"],
    ["error", "error", "error"],
  ] as const)(
    "%s shows a %s toast and buzzes with the %s pattern",
    async (fn, toastFn, severity) => {
      markToasterMounted();
      notify[fn]("Message");
      expect(haptic).toHaveBeenCalledWith(severity);
      await vi.waitFor(() =>
        expect(toast[toastFn]).toHaveBeenCalledWith("Message", undefined),
      );
    },
  );

  it("critical buzzes with the critical pattern and shows an error toast that stays", async () => {
    markToasterMounted();
    notify.critical("Booking failed");
    expect(haptic).toHaveBeenCalledWith("critical");
    await vi.waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Booking failed", {
        duration: Infinity,
      }),
    );
  });
});
