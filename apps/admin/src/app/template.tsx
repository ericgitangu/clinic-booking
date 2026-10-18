import type { ReactNode } from "react";

// A template (unlike a layout) mounts again on every navigation, so each page arrives with the
// thin sweep line defined in theme.css. Reduced motion turns it off there.
export default function Template({ children }: { children: ReactNode }) {
  return (
    <>
      <div aria-hidden className="route-sweep" />
      {children}
    </>
  );
}
