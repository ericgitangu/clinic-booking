// Short, distinct vibration patterns by outcome. A no-op where the browser has no Vibration API
// (iOS Safari) and for people who asked for reduced motion.
export type Severity = "success" | "info" | "warning" | "error" | "critical";

export const PATTERNS: Record<Severity, readonly number[]> = {
  success: [12],
  info: [20, 40, 20],
  warning: [20, 40, 20],
  error: [40, 30, 40],
  critical: [80, 40, 80, 40, 80],
};

export function vibrate(severity: Severity): boolean {
  if (
    typeof navigator === "undefined" ||
    typeof navigator.vibrate !== "function"
  )
    return false;
  if (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  ) {
    return false;
  }
  return navigator.vibrate([...PATTERNS[severity]]);
}
