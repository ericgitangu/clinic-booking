import {
  Card,
  CardContent,
  CardDescription,
  CardTitle,
} from "@clinic/ui/components/ui/card";

export interface Kpi {
  label: string;
  value: string;
  note: string;
}

// Four numbers the front desk looks at first. The note says what the number counts, so nobody has
// to guess whether "7" means this week or all time.
export function KpiStrip({ items }: { items: readonly Kpi[] }) {
  return (
    <section aria-label="Key numbers">
      <ul className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {items.map((k) => (
          <li key={k.label}>
            <Card className="h-full gap-1 py-4">
              <CardContent className="px-4">
                <CardDescription className="text-sm">{k.label}</CardDescription>
                <CardTitle
                  className="mt-1 font-heading text-3xl font-semibold tabular-nums"
                  data-testid={`kpi-${k.label.toLowerCase().replace(/[^a-z]+/g, "-")}`}
                >
                  {k.value}
                </CardTitle>
                <p className="mt-1 text-sm text-muted-foreground">{k.note}</p>
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
    </section>
  );
}
