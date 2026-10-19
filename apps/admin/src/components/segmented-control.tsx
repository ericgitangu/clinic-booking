"use client";

import {
  Suspense,
  useOptimistic,
  useRef,
  useTransition,
  type KeyboardEvent,
} from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { haptic } from "@clinic/ui/lib/haptics";
import { cn } from "@clinic/ui/lib/utils";

export interface Segment {
  value: string;
  label: string;
}

// A radio group drawn as a row of buttons. The choice lives in the address (?name=value), so a
// refresh or a shared link shows the same view. Arrow keys move the choice, as in any radio
// group: only the chosen button is in the tab order, Home and End jump to the ends.
function Segmented({
  label,
  name,
  value,
  options,
  className,
}: {
  /** What the group chooses, read out with the group, e.g. "Show". */
  label: string;
  /** The query parameter that holds the choice. */
  name: string;
  value: string;
  options: readonly Segment[];
  className?: string;
}) {
  const router = useRouter();
  const path = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [shown, setShown] = useOptimistic(value);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  function choose(next: string) {
    if (next === value) return;
    haptic("info");
    const sp = new URLSearchParams(params.toString());
    sp.set(name, next);
    sp.delete("cursor");
    startTransition(() => {
      setShown(next);
      router.push(`${path}?${sp.toString()}`, { scroll: false });
    });
  }

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = options.length - 1;
    let to: number;
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        to = index === last ? 0 : index + 1;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        to = index === 0 ? last : index - 1;
        break;
      case "Home":
        to = 0;
        break;
      case "End":
        to = last;
        break;
      default:
        return;
    }
    e.preventDefault();
    buttons.current[to]?.focus();
    choose(options[to]!.value);
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-busy={pending}
      data-testid={`segmented-${name}`}
      className={cn(
        "inline-flex rounded-lg bg-muted p-1 motion-safe:transition-opacity",
        pending && "opacity-70",
        className,
      )}
    >
      {options.map((o, i) => {
        const checked = o.value === shown;
        return (
          <button
            key={o.value}
            ref={(el) => {
              buttons.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            onClick={() => choose(o.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(
              "inline-flex min-h-11 flex-1 items-center justify-center rounded-md px-4 text-sm whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring motion-safe:transition-colors",
              checked
                ? "bg-background font-semibold text-foreground shadow-sm ring-1 ring-border"
                : "font-medium text-muted-foreground hover:text-foreground",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

interface Props {
  label: string;
  name: string;
  value: string;
  options: readonly Segment[];
  className?: string;
}

// useSearchParams needs a Suspense boundary above it. The fallback is the same group, readable
// but not yet interactive, so the page does not jump when the real one arrives.
export function SegmentedControl(props: Props) {
  return (
    <Suspense
      fallback={
        <div
          role="radiogroup"
          aria-label={props.label}
          className={cn("inline-flex rounded-lg bg-muted p-1", props.className)}
        >
          {props.options.map((o) => (
            <span
              key={o.value}
              role="radio"
              aria-checked={o.value === props.value}
              className={cn(
                "inline-flex min-h-11 flex-1 items-center justify-center rounded-md px-4 text-sm whitespace-nowrap",
                o.value === props.value
                  ? "bg-background font-semibold ring-1 ring-border"
                  : "font-medium text-muted-foreground",
              )}
            >
              {o.label}
            </span>
          ))}
        </div>
      }
    >
      <Segmented {...props} />
    </Suspense>
  );
}
