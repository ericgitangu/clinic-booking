import { beforeEach, describe, expect, it, vi } from "vitest";

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}));
const vibrate = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast }));
vi.mock("@/lib/haptics", () => ({ vibrate }));

import { notify } from "@/lib/notify";

beforeEach(() => vi.clearAllMocks());

describe("notify", () => {
  it.each([
    ["success", "success", "success"],
    ["info", "info", "info"],
    ["warning", "warning", "warning"],
    ["error", "error", "error"],
  ] as const)(
    "%s shows a %s toast and buzzes with the %s pattern",
    (fn, toastFn, severity) => {
      notify[fn]("Message");
      expect(vibrate).toHaveBeenCalledWith(severity);
      expect(toast[toastFn]).toHaveBeenCalledWith("Message", undefined);
    },
  );

  it("critical buzzes with the critical pattern and shows an error toast that stays", () => {
    notify.critical("Booking failed");
    expect(vibrate).toHaveBeenCalledWith("critical");
    expect(toast.error).toHaveBeenCalledWith("Booking failed", {
      duration: Infinity,
    });
  });
});
