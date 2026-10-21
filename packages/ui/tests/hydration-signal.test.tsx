// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HydrationSignal } from "@clinic/ui/components/app-shell/hydration-signal";

const root = document.documentElement;

beforeEach(() => {
  delete root.dataset.hydrated;
});
afterEach(cleanup);

describe("HydrationSignal", () => {
  it("renders nothing on the server and does not touch the document", () => {
    expect(renderToString(<HydrationSignal />)).toBe("");
    expect(root.hasAttribute("data-hydrated")).toBe(false);
  });

  it("marks <html> once it has mounted", () => {
    expect(root.hasAttribute("data-hydrated")).toBe(false);
    render(<HydrationSignal />);
    expect(root.dataset.hydrated).toBe("true");
  });

  it("clears the mark when the tree goes away", () => {
    const { unmount } = render(<HydrationSignal />);
    unmount();
    expect(root.hasAttribute("data-hydrated")).toBe(false);
  });
});
