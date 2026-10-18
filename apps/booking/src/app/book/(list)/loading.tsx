import { Skeleton } from "@clinic/ui/components/ui/skeleton";

// Shown while the doctor list loads: cards of the same size as the real ones, so nothing jumps.
export default function Loading() {
  return (
    <section className="py-10" aria-busy="true" aria-label="Loading doctors">
      <Skeleton className="h-10 w-56" />
      <Skeleton className="mt-4 h-6 w-full max-w-[60ch]" />
      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-44 rounded-xl" />
        ))}
      </div>
    </section>
  );
}
