import { afterEach, expect, it, vi } from "vitest";
import { load } from "@/components/architecture/tab-bar";

// The panel loader must fetch a tab once even when it is asked twice while the first fetch is out:
// a second fetch would swap in fresh HTML and undo the card the first load had opened.

function fakePanel(src: string) {
  return {
    dataset: { src } as Record<string, string>,
    innerHTML: "",
    querySelector: () => null,
    setAttribute: () => undefined,
    removeAttribute: () => undefined,
  } as unknown as HTMLElement;
}

afterEach(() => vi.unstubAllGlobals());

function stubFetch() {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const fetchMock = vi.fn(async () => {
    await gate;
    return { ok: true, text: async () => "<main data-fragment>x</main>" };
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal(
    "DOMParser",
    class {
      parseFromString() {
        return { querySelector: () => ({ innerHTML: "<p>cards</p>" }) };
      }
    },
  );
  return { fetchMock, release };
}

it("fetches a panel once when it is loaded twice at the same time", async () => {
  const { fetchMock, release } = stubFetch();
  const panel = fakePanel("/decisions/panel/api");
  const a = load(panel);
  const b = load(panel);
  release();
  expect(await Promise.all([a, b])).toEqual([true, true]);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(panel.dataset.loaded).toBe("1");
  expect(await load(panel)).toBe(true);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("lets a failed load be tried again", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: false, status: 500 })),
  );
  const panel = fakePanel("/decisions/panel/api");
  expect(await load(panel)).toBe(false);
  expect(await load(panel)).toBe(false);
  expect(fetch).toHaveBeenCalledTimes(2);
});
