// Whether the single-key shortcuts (j, k, g then d, /, ?) are on. WCAG 2.1.4 asks for a way to turn
// them off: a person using speech input or a one-handed keyboard can fire them by accident. The
// choice is kept in this browser only. Ctrl or Cmd plus K always works, it needs a modifier.
export const SINGLE_KEYS_KEY = "admin.single-key-shortcuts";
export const SINGLE_KEYS_EVENT = "admin:single-keys";

interface Store {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function store(): Store | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null; // storage blocked: the default applies and the choice lasts this page only
  }
}

/** On unless the person turned them off. */
export function readSingleKeys(s: Store | null = store()): boolean {
  try {
    return s?.getItem(SINGLE_KEYS_KEY) !== "off";
  } catch {
    return true;
  }
}

export function writeSingleKeys(on: boolean, s: Store | null = store()): void {
  try {
    s?.setItem(SINGLE_KEYS_KEY, on ? "on" : "off");
  } catch {
    // Nothing to do: the in-memory event below still updates this page.
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(SINGLE_KEYS_EVENT, { detail: on }));
  }
}

export function subscribeSingleKeys(onChange: () => void): () => void {
  window.addEventListener(SINGLE_KEYS_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(SINGLE_KEYS_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}
