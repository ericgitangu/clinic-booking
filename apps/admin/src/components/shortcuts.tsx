"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { KeyboardIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Button } from "@clinic/ui/components/ui/button";
import { IDLE, interpret, type ChordState } from "@/lib/hotkeys";
import {
  readSingleKeys,
  subscribeSingleKeys,
  writeSingleKeys,
} from "@/lib/shortcut-setting";

// The dialogs (and the dialog code behind them) load on the first use, not with the page.
const load = () => import("@/components/shortcuts-dialogs");
const Dialogs = dynamic(() => load().then((m) => m.ShortcutsDialogs), {
  ssr: false,
});

export type Panel = "help" | "palette" | null;

/** The rows the j and k keys walk through: every link marked data-row-link on the page. */
function rowLinks(): HTMLAnchorElement[] {
  return [
    ...document.querySelectorAll<HTMLAnchorElement>("a[data-row-link]"),
  ].filter((a) => a.offsetParent !== null);
}

// One keydown listener for the whole app, plus the header button that opens search for anyone
// without a keyboard. The rules are in lib/hotkeys.ts. Shortcuts are documented in the help dialog
// ("?"), which reads the same list.
export function Shortcuts({ canManage }: { canManage: boolean }) {
  const router = useRouter();
  const [panel, setPanel] = useState<Panel>(null);
  const chord = useRef<ChordState>(IDLE);
  const panelOpen = useRef(false);
  panelOpen.current = panel !== null;
  // Single keys can be switched off (WCAG 2.1.4). The server render says on; the browser's own
  // choice is read after hydration.
  const singleKeys = useSyncExternalStore(
    subscribeSingleKeys,
    () => readSingleKeys(),
    () => true,
  );

  const moveRow = useCallback((step: 1 | -1) => {
    const rows = rowLinks();
    if (rows.length === 0) return;
    const at = rows.indexOf(document.activeElement as HTMLAnchorElement);
    const next =
      at === -1
        ? step === 1
          ? 0
          : rows.length - 1
        : Math.min(rows.length - 1, Math.max(0, at + step));
    rows[next]?.focus();
    rows[next]?.scrollIntoView({ block: "nearest" });
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const out = interpret(
        e,
        chord.current,
        e.timeStamp,
        panelOpen.current,
        singleKeys,
      );
      chord.current = out.state;
      if (!out.action) return;
      if (out.consume) e.preventDefault();
      const a = out.action;
      if (a.type === "help") setPanel("help");
      else if (a.type === "palette") setPanel("palette");
      else if (a.type === "row") moveRow(a.step);
      else if (a.to === "/dashboard" || canManage) router.push(a.to);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [canManage, moveRow, router, singleKeys]);

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="size-11"
        aria-label="Search and keyboard shortcuts"
        aria-haspopup="dialog"
        onClick={() => setPanel("palette")}
        onPointerEnter={() => void load()}
        onFocus={() => void load()}
      >
        <KeyboardIcon className="size-5" aria-hidden />
      </Button>
      {panel !== null && (
        <Dialogs
          panel={panel}
          setPanel={setPanel}
          canManage={canManage}
          singleKeys={singleKeys}
          setSingleKeys={writeSingleKeys}
        />
      )}
    </>
  );
}
