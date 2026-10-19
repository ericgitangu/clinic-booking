import { Skeleton } from "@clinic/ui/components/ui/skeleton";

// Shown while the dashboard's numbers load. The shapes match the page so nothing jumps when the
// real content arrives.
export default function Loading() {
  return (
    <div
      className="space-y-6 py-6 [&_[data-slot=skeleton]]:motion-reduce:animate-none"
      role="status"
      aria-live="polite"
    >
      <span className="sr-only">Loading the dashboard</span>
      <Skeleton className="h-9 w-40" />
      <div className="grid gap-3 lg:grid-cols-2">
        <Skeleton className="h-56 rounded-xl" />
        <Skeleton className="h-56 rounded-xl" />
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-32 rounded-xl" />
        ))}
      </div>
      <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
        <Skeleton className="h-72 rounded-xl" />
        <Skeleton className="h-72 rounded-xl" />
      </div>
      <Skeleton className="h-64 rounded-xl" />
    </div>
  );
}
