// Short, distinct vibration patterns by outcome. `haptic()` does nothing, and never throws, when:
// the browser has no Vibration API (iOS Safari, desktop), the person has not touched the page yet
// (browsers refuse a buzz before a gesture), they asked for reduced motion, or they switched
// vibration off in the menu (kept in localStorage; storage can be blocked, so every access is guarded).
export type Severity = "success" | "info" | "warning" | "error" | "critical";

export const PATTERNS: Record<Severity, readonly number[]> = {
  success: [12],
  info: [20, 40, 20],
  warning: [20, 40, 20],
  error: [40, 30, 40],
  critical: [80, 40, 80, 40, 80],
};

export const HAPTICS_KEY = "clinic:haptics";
const CHANGE_EVENT = "clinic:haptics-change";

export function hapticsSupported(): boolean {
  return (
    typeof navigator !== "undefined" && typeof navigator.vibrate === "function"
  );
}

// Worth offering the switch: the browser has the API AND the main pointer is a finger. Desktop
// Chrome exposes navigator.vibrate but no laptop can buzz, so a switch there would do nothing.
export function hapticsPlausible(): boolean {
  if (!hapticsSupported()) return false;
  try {
    return window.matchMedia("(pointer: coarse)").matches;
  } catch {
    return false;
  }
}

// On unless the person turned it off.
export function hapticsEnabled(): boolean {
  try {
    return window.localStorage.getItem(HAPTICS_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setHapticsEnabled(on: boolean): void {
  try {
    window.localStorage.setItem(HAPTICS_KEY, on ? "on" : "off");
  } catch {
    // Storage is blocked: the choice lasts until the page is closed.
  }
  try {
    window.dispatchEvent(new Event(CHANGE_EVENT));
  } catch {
    // No window to tell.
  }
}

export function subscribeHaptics(onChange: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

export function haptic(severity: Severity): boolean {
  try {
    if (!hapticsSupported()) return false;
    if (typeof window === "undefined") return false;
    if (!hapticsEnabled()) return false;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches)
      return false;
    // Chrome ignores (and logs) a buzz before the first tap or key press.
    if (navigator.userActivation && !navigator.userActivation.hasBeenActive)
      return false;
    return navigator.vibrate([...PATTERNS[severity]]);
  } catch {
    return false;
  }
}
