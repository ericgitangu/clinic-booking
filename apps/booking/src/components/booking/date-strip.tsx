import Link from "next/link";
import { addDays, formatDayShort } from "@/lib/clinic-time";

// Two weeks of days as large tap targets, plus a date box for anything further out (up to 90 days
// ahead). Plain links and a GET form: it works without JavaScript.
export function DateStrip({
  today,
  selected,
  basePath,
}: {
  today: string;
  selected: string;
  basePath: string;
}) {
  const days = Array.from({ length: 14 }, (_, i) => addDays(today, i));
  return (
    <div>
      <nav aria-label="Pick a day">
        <ul className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-2 [scrollbar-width:thin]">
          {days.map((d) => {
            const f = formatDayShort(d);
            const on = d === selected;
            return (
              <li key={d} className="shrink-0">
                <Link
                  href={`${basePath}?date=${d}`}
                  aria-current={on ? "date" : undefined}
                  className={
                    "flex min-h-16 w-16 flex-col items-center justify-center rounded-xl border text-center focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring " +
                    (on
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-card hover:bg-accent")
                  }
                >
                  <span className="text-sm">{f.weekday}</span>
                  <span className="text-base font-semibold">{f.date}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <form
        action={basePath}
        method="get"
        className="mt-3 flex items-center gap-2"
      >
        <label htmlFor="date" className="text-base">
          Another date
        </label>
        <input
          id="date"
          name="date"
          type="date"
          min={today}
          max={addDays(today, 90)}
          defaultValue={selected}
          className="h-11 rounded-md border border-border bg-background px-3 text-base"
        />
        <button
          type="submit"
          className="inline-flex h-11 items-center rounded-md border border-border px-4 text-base hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
        >
          Go
        </button>
      </form>
    </div>
  );
}
