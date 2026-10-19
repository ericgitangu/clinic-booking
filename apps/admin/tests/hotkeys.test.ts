import { describe, expect, it } from "vitest";
import { IDLE, interpret, isTypingTarget, type KeyLike } from "@/lib/hotkeys";

const key = (k: string, extra: Partial<KeyLike> = {}): KeyLike => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  target: { tagName: "BODY" },
  ...extra,
});

describe("keyboard shortcuts", () => {
  it("reads g then d as go to the dashboard", () => {
    const first = interpret(key("g"), IDLE, 0, false);
    expect(first.action).toBeNull();
    const second = interpret(key("d"), first.state, 300, false);
    expect(second.action).toEqual({ type: "go", to: "/dashboard" });
  });

  it("lets a chord lapse after a second", () => {
    const first = interpret(key("g"), IDLE, 0, false);
    expect(interpret(key("d"), first.state, 1500, false).action).toBeNull();
  });

  it("never fires while typing in a field", () => {
    for (const tagName of ["INPUT", "TEXTAREA", "SELECT"]) {
      const r = interpret(key("j", { target: { tagName } }), IDLE, 0, false);
      expect(r.action).toBeNull();
      expect(r.consume).toBe(false);
    }
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: true })).toBe(
      true,
    );
  });

  it("leaves browser shortcuts and open dialogs alone", () => {
    expect(
      interpret(key("j", { ctrlKey: true }), IDLE, 0, false).action,
    ).toBeNull();
    expect(interpret(key("j"), IDLE, 0, true).action).toBeNull();
  });

  it("opens the palette with / or Ctrl K, even from a field for Ctrl K", () => {
    expect(interpret(key("/"), IDLE, 0, false).action).toEqual({
      type: "palette",
    });
    const inField = key("k", { ctrlKey: true, target: { tagName: "INPUT" } });
    expect(interpret(inField, IDLE, 0, false).action).toEqual({
      type: "palette",
    });
  });

  it("moves through rows with j and k", () => {
    expect(interpret(key("j"), IDLE, 0, false).action).toEqual({
      type: "row",
      step: 1,
    });
    expect(interpret(key("k"), IDLE, 0, false).action).toEqual({
      type: "row",
      step: -1,
    });
  });

  it("with single keys off, only the Ctrl or Cmd plus K chord is left (WCAG 2.1.4)", () => {
    for (const k of ["j", "k", "g", "/", "?"]) {
      const r = interpret(key(k), IDLE, 0, false, false);
      expect(r.action).toBeNull();
      expect(r.consume).toBe(false);
    }
    expect(
      interpret(key("k", { ctrlKey: true }), IDLE, 0, false, false).action,
    ).toEqual({
      type: "palette",
    });
    expect(
      interpret(key("k", { metaKey: true }), IDLE, 0, false, false).action,
    ).toEqual({
      type: "palette",
    });
  });

  it("starts no g chord while single keys are off", () => {
    const first = interpret(key("g"), IDLE, 0, false, false);
    expect(first.state).toEqual(IDLE);
    expect(
      interpret(key("d"), first.state, 100, false, false).action,
    ).toBeNull();
  });
});
