"use client";

import { SearchIcon } from "lucide-react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useEffect, useId, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@clinic/ui/components/ui/dialog";
import { cn } from "@clinic/ui/lib/utils";
import { SHORTCUTS } from "@/lib/hotkeys";
import { RANGES, STATUSES, STATUS_LABEL } from "@/lib/filters";
import type { Panel } from "@/components/shortcuts";

interface Command {
  id: string;
  label: string;
  group: string;
  run: () => void;
}

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="inline-flex min-h-6 min-w-6 items-center justify-center rounded-md border border-border bg-muted px-1.5 font-sans text-xs font-medium text-foreground shadow-[0_1px_0_var(--border)]">
      {children}
    </kbd>
  );
}

function Help({
  singleKeys,
  setSingleKeys,
}: {
  singleKeys: boolean;
  setSingleKeys: (on: boolean) => void;
}) {
  return (
    <>
      <DialogTitle className="text-lg">Keyboard shortcuts</DialogTitle>
      <DialogDescription>
        They stay out of the way while you type in a field.
      </DialogDescription>
      <div className="flex items-start gap-3 rounded-lg border border-border p-3">
        <input
          id="single-keys"
          type="checkbox"
          checked={singleKeys}
          onChange={(e) => setSingleKeys(e.target.checked)}
          className="mt-1 size-5 shrink-0 accent-[var(--primary)]"
        />
        <label htmlFor="single-keys" className="text-sm">
          <span className="block font-medium">Single-key shortcuts</span>
          <span className="block text-muted-foreground">
            Turn off if letter keys fire by accident, for example with speech
            input. Ctrl or Cmd plus K keeps working, and so does the search
            button in the header.
          </span>
        </label>
      </div>
      <dl className="grid gap-3">
        {SHORTCUTS.map((s) => (
          <div key={s.does} className="flex items-center justify-between gap-4">
            <dt className="text-muted-foreground">{s.does}</dt>
            <dd className="flex items-center gap-1.5">
              {s.keys.map((k, i) => (
                <span key={k} className="flex items-center gap-1.5">
                  {i > 0 && (
                    <span className="text-xs text-muted-foreground">
                      {s.join}
                    </span>
                  )}
                  <Kbd>{k}</Kbd>
                </span>
              ))}
            </dd>
          </div>
        ))}
      </dl>
    </>
  );
}

// A small command palette: go places, change the view, jump to an appointment on this page. It
// searches the commands and the rows already on screen, not the whole database.
function Palette({
  isOwner,
  close,
  showHelp,
  singleKeys,
  setSingleKeys,
}: {
  isOwner: boolean;
  close: () => void;
  showHelp: () => void;
  singleKeys: boolean;
  setSingleKeys: (on: boolean) => void;
}) {
  const router = useRouter();
  const path = usePathname();
  const params = useSearchParams();
  const uid = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [
      {
        id: "dash",
        label: "Dashboard",
        group: "Go to",
        run: () => router.push("/dashboard"),
      },
    ];
    if (isOwner) {
      list.push({
        id: "access",
        label: "Access",
        group: "Go to",
        run: () => router.push("/access"),
      });
    }
    const view = (name: string, value: string) => () => {
      const sp = new URLSearchParams(
        path === "/dashboard" ? params.toString() : "",
      );
      sp.set(name, value);
      sp.delete("cursor");
      router.push(`/dashboard?${sp.toString()}`);
    };
    for (const d of RANGES) {
      list.push({
        id: `d${d}`,
        label: `Show the last ${d} days`,
        group: "View",
        run: view("days", String(d)),
      });
    }
    for (const s of STATUSES) {
      list.push({
        id: `s${s}`,
        label: `Show ${STATUS_LABEL[s].toLowerCase()} appointments`,
        group: "View",
        run: view("status", s),
      });
    }
    list.push({
      id: "help",
      label: "Keyboard shortcuts and settings",
      group: "Help",
      run: showHelp,
    });
    list.push({
      id: "single-keys",
      label: singleKeys
        ? "Turn single-key shortcuts off"
        : "Turn single-key shortcuts on",
      group: "Help",
      run: () => setSingleKeys(!singleKeys),
    });
    document
      .querySelectorAll<HTMLAnchorElement>("a[data-row-link]")
      .forEach((a, i) => {
        if (a.offsetParent === null) return;
        list.push({
          id: `row${i}`,
          label: a.dataset.rowLabel ?? a.textContent ?? "Appointment",
          group: "Appointment",
          run: () => router.push(a.getAttribute("href") ?? "/dashboard"),
        });
      });
    return list;
  }, [isOwner, params, path, router, showHelp, singleKeys, setSingleKeys]);

  const shown = commands.filter((c) =>
    c.label.toLowerCase().includes(query.trim().toLowerCase()),
  );
  useEffect(() => setActive(0), [query]);

  function pick(c: Command | undefined) {
    if (!c) return;
    if (c.id !== "help") close();
    c.run();
  }

  return (
    <>
      <DialogTitle className="sr-only">Search</DialogTitle>
      <DialogDescription className="sr-only">
        Type to find a command or an appointment on this page. Use the arrow
        keys and Enter.
      </DialogDescription>
      <div className="flex items-center gap-2 border-b border-border pb-3">
        <SearchIcon
          className="size-4 shrink-0 text-muted-foreground"
          aria-hidden
        />
        <input
          autoFocus
          role="combobox"
          aria-expanded
          aria-controls={`${uid}-list`}
          aria-activedescendant={
            shown[active] ? `${uid}-${shown[active].id}` : undefined
          }
          aria-label="Search commands and appointments"
          placeholder="Search commands and appointments on this page"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(shown.length - 1, a + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              pick(shown[active]);
            }
          }}
          className="min-h-11 w-full bg-transparent text-base outline-none placeholder:text-muted-foreground"
        />
      </div>
      <ul
        id={`${uid}-list`}
        role="listbox"
        aria-label="Results"
        className="-mx-2 max-h-72 overflow-y-auto"
      >
        {shown.length === 0 ? (
          <li
            role="presentation"
            className="px-2 py-6 text-center text-muted-foreground"
          >
            Nothing matches. Try a doctor, a patient or a command like
            “cancelled”.
          </li>
        ) : (
          shown.map((c, i) => (
            <li
              key={c.id}
              id={`${uid}-${c.id}`}
              role="option"
              aria-selected={i === active}
              onMouseMove={() => setActive(i)}
              onClick={() => pick(c)}
              className={cn(
                "flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-lg px-2 text-sm",
                i === active && "bg-muted",
              )}
            >
              <span className="truncate">{c.label}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {c.group}
              </span>
            </li>
          ))
        )}
      </ul>
    </>
  );
}

export function ShortcutsDialogs({
  panel,
  setPanel,
  isOwner,
  singleKeys,
  setSingleKeys,
}: {
  panel: Exclude<Panel, null>;
  setPanel: (p: Panel) => void;
  isOwner: boolean;
  singleKeys: boolean;
  setSingleKeys: (on: boolean) => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && setPanel(null)}>
      <DialogContent showCloseButton={panel === "help"} className="sm:max-w-md">
        {panel === "help" ? (
          <Help singleKeys={singleKeys} setSingleKeys={setSingleKeys} />
        ) : (
          <Palette
            isOwner={isOwner}
            close={() => setPanel(null)}
            showHelp={() => setPanel("help")}
            singleKeys={singleKeys}
            setSingleKeys={setSingleKeys}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
