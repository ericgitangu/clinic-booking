// The rules behind the keyboard shortcuts, kept free of React and the DOM so they can be tested.
//
// Shortcuts are single keys or a two-key chord ("g" then "d"). They never fire while someone is
// typing, with Ctrl, Alt or Meta held (the browser's and the screen reader's own keys), or while
// a dialog is open: a person who types a "j" into a form must get a "j".

export const CHORD_WINDOW_MS = 1000;

export interface ShortcutDoc {
  keys: readonly string[];
  /** Joins the keys in the help text: "then" for a chord, "or" for alternatives. */
  join: "then" | "or" | "";
  does: string;
}

export const SHORTCUTS: readonly ShortcutDoc[] = [
  { keys: ["?"], join: "", does: "Show this list" },
  { keys: ["/", "Ctrl K"], join: "or", does: "Search and run commands" },
  { keys: ["g", "d"], join: "then", does: "Go to the dashboard" },
  { keys: ["g", "a"], join: "then", does: "Go to access (owners and admins)" },
  {
    keys: ["j", "k"],
    join: "or",
    does: "Move down or up the appointment list",
  },
  { keys: ["Enter"], join: "", does: "Open the appointment you are on" },
  { keys: ["Esc"], join: "", does: "Close a dialog" },
];

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  defaultPrevented?: boolean;
  target: unknown;
}

interface ElementLike {
  tagName?: string;
  isContentEditable?: boolean;
  getAttribute?: (name: string) => string | null;
}

/** True for anything a person types into, or a widget that owns the arrow and letter keys. */
export function isTypingTarget(target: unknown): boolean {
  const el = target as ElementLike | null;
  if (!el || typeof el !== "object") return false;
  const tag = (el.tagName ?? "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el.isContentEditable) return true;
  const role = el.getAttribute?.("role");
  return role === "textbox" || role === "combobox" || role === "searchbox";
}

export type Action =
  | { type: "help" }
  | { type: "palette" }
  | { type: "go"; to: "/dashboard" | "/access" }
  | { type: "row"; step: 1 | -1 };

export interface ChordState {
  /** The first key of a chord, waiting for its second. */
  pending: "g" | null;
  at: number;
}

export const IDLE: ChordState = { pending: null, at: 0 };

/**
 * What a key press means, given the chord in progress. `dialogOpen` suppresses everything: the
 * dialog handles its own keys. Returns the next chord state and the action, if any.
 */
export function interpret(
  e: KeyLike,
  state: ChordState,
  now: number,
  dialogOpen: boolean,
  /** Single keys are on. Off leaves only the Ctrl or Cmd plus K chord (WCAG 2.1.4). */
  singleKeys = true,
): { state: ChordState; action: Action | null; consume: boolean } {
  const none = { state: IDLE, action: null, consume: false };
  if (dialogOpen || e.defaultPrevented) return none;

  // Ctrl or Cmd plus K opens the palette even from a text field; it is not a typed character.
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "k") {
    return { state: IDLE, action: { type: "palette" }, consume: true };
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return none;
  if (!singleKeys) return none;
  if (isTypingTarget(e.target)) return none;

  const live = state.pending !== null && now - state.at <= CHORD_WINDOW_MS;
  if (live && state.pending === "g") {
    if (e.key === "d") {
      return {
        state: IDLE,
        action: { type: "go", to: "/dashboard" },
        consume: true,
      };
    }
    if (e.key === "a") {
      return {
        state: IDLE,
        action: { type: "go", to: "/access" },
        consume: true,
      };
    }
  }
  switch (e.key) {
    case "g":
      return { state: { pending: "g", at: now }, action: null, consume: false };
    case "?":
      return { state: IDLE, action: { type: "help" }, consume: true };
    case "/":
      return { state: IDLE, action: { type: "palette" }, consume: true };
    case "j":
      return { state: IDLE, action: { type: "row", step: 1 }, consume: true };
    case "k":
      return { state: IDLE, action: { type: "row", step: -1 }, consume: true };
    default:
      return none;
  }
}
