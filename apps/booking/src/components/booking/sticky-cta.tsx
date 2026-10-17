import type { ReactNode } from "react";

// The primary action, pinned to the bottom of the screen so a thumb always reaches it. The page
// that uses it adds bottom padding (pb-28) so the last field is never hidden behind the bar, and
// globals.css pads the footer so the bar never covers its last line.
export function StickyCta({
  children,
  hint,
}: {
  children: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div
      data-sticky-cta
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80"
    >
      <div className="pad-safe-x mx-auto flex w-full max-w-5xl flex-col gap-1 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">
        {hint ? <p className="text-sm text-muted-foreground">{hint}</p> : null}
        {children}
      </div>
    </div>
  );
}
