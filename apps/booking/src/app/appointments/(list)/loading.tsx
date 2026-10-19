import { Skeleton } from "@clinic/ui/components/ui/skeleton";

export default function Loading() {
  return (
    <section
      className="py-10"
      aria-busy="true"
      aria-label="Loading appointments"
    >
      <Skeleton className="h-10 w-64" />
      <Skeleton className="mt-3 h-6 w-48" />
      <Skeleton className="mt-8 h-7 w-28" />
      <div className="mt-4 space-y-4">
        {Array.from({ length: 2 }, (_, i) => (
          <Skeleton key={i} className="h-32 rounded-xl" />
        ))}
      </div>
    </section>
  );
}
