import { ArrowUpRight, Play } from "lucide-react";
import Link from "next/link";
import { Badge } from "@clinic/ui/components/ui/badge";
import { swaggerLink, type Evidence } from "@/lib/evidence";

// One claim about the API with the two places to check it: the operation in Swagger and the screen
// that uses it. The rail on the left says whether the brief required it (solid) or it is a bonus.
export function EvidenceCard({
  e,
  required,
}: {
  e: Evidence;
  required: boolean;
}) {
  return (
    <li
      className={
        "flex flex-col rounded-lg border border-border bg-card p-5 border-l-4 " +
        (required ? "border-l-primary" : "border-l-border")
      }
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Badge
          variant={e.method === "GET" ? "outline" : "default"}
          className="font-mono"
        >
          {e.method}
        </Badge>
        <code className="break-all text-base font-semibold">{e.path}</code>
      </div>
      <p className="mt-3 text-base leading-7">{e.summary}</p>
      <ul className="mt-3 flex flex-wrap gap-2" aria-label="Errors it returns">
        {e.errors.map((x) => (
          <li key={`${x.status}-${x.code}`}>
            <code className="rounded-md bg-muted px-2 py-1 text-sm">
              {x.status} {x.code}
            </code>
          </li>
        ))}
      </ul>
      <div className="mt-auto flex flex-wrap gap-x-5 pt-4">
        <a
          href={swaggerLink(e)}
          className="inline-flex min-h-11 items-center gap-1.5 text-base font-medium underline underline-offset-4 hover:text-primary focus-visible:outline-2 focus-visible:outline-ring"
        >
          <Play aria-hidden className="size-4" />
          Try it in Swagger
        </a>
        <Link
          href={e.screen.href}
          className="inline-flex min-h-11 items-center gap-1.5 text-base font-medium underline underline-offset-4 hover:text-primary focus-visible:outline-2 focus-visible:outline-ring"
        >
          <ArrowUpRight aria-hidden className="size-4" />
          {e.screen.label}
        </Link>
      </div>
    </li>
  );
}
