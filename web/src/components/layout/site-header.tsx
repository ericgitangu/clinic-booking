import Link from "next/link";
import { LotusMark } from "@/components/brand/lotus-mark";
import { ThemeToggle } from "@/components/layout/theme-toggle";

export function SiteHeader() {
  return (
    <header className="border-b border-border">
      <div className="mx-auto flex h-16 w-full max-w-5xl items-center justify-between px-5">
        <Link
          href="/"
          className="flex items-center gap-3 rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
        >
          <LotusMark size={36} />
          <span className="font-heading text-lg font-semibold tracking-tight">
            Idyllic
          </span>
        </Link>
        <nav aria-label="Primary" className="flex items-center gap-1">
          <a
            href="/docs"
            className="rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          >
            API docs
          </a>
          <ThemeToggle />
        </nav>
      </div>
    </header>
  );
}
