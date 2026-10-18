"use client";

import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { usePathname } from "next/navigation";
import { Fragment } from "react";
import { resolveTrail, type ShellRoutes } from "@clinic/ui/lib/shell-trail";

const LINK =
  "rounded-sm underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

// Where this page sits and the way back. Plain anchors with real hrefs (never history.back()), so
// the link works from a shared URL or a fresh tab. A phone shows one "Back to <parent>" link; wider
// screens show the whole trail. Root pages show nothing.
export function ShellTrail({ config }: { config: ShellRoutes }) {
  const { crumbs, parent } = resolveTrail(usePathname(), config);
  if (!parent) return null;
  return (
    <nav
      aria-label="Breadcrumb"
      data-shell="trail"
      className="pad-safe-x mx-auto w-full max-w-5xl pt-2 text-sm text-muted-foreground"
    >
      <a
        href={parent.href}
        className={`${LINK} -ml-2 inline-flex min-h-11 items-center gap-1 px-2 text-base sm:hidden`}
      >
        <ChevronLeftIcon aria-hidden className="size-4" />
        Back to {parent.label}
      </a>
      <ol className="-ml-1 hidden min-h-11 flex-wrap items-center gap-x-1 sm:flex">
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          return (
            <Fragment key={c.href}>
              <li className="inline-flex items-center">
                {last ? (
                  <span
                    aria-current="page"
                    className="font-medium text-foreground"
                  >
                    {c.label}
                  </span>
                ) : (
                  <a
                    href={c.href}
                    className={`${LINK} inline-flex min-h-11 items-center px-1`}
                  >
                    {c.label}
                  </a>
                )}
              </li>
              {last ? null : (
                <li aria-hidden className="inline-flex items-center">
                  <ChevronRightIcon className="size-4" />
                </li>
              )}
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
}
