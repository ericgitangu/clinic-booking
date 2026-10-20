import type { ReactNode } from "react";
import { ZONE_NOTE } from "@clinic/ui/lib/zone-note";

// Names the zone every time on the page is shown in. Plain text in the muted foreground, which
// clears 4.5:1 on the page and card backgrounds in both themes; it is not a tooltip and not hidden.
export function ZoneNote({
  className = "",
  children,
}: {
  className?: string;
  children?: ReactNode;
}) {
  return (
    <p
      data-testid="zone-note"
      className={`text-sm text-muted-foreground ${className}`.trim()}
    >
      {ZONE_NOTE}.{children ? <> {children}</> : null}
    </p>
  );
}
