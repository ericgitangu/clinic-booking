"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";

// A plain labelled select, because the browser's own control is the most accessible one there is.
// The choice lives in the address (?doctor=), so it survives a refresh and can be shared.
function Inner({
  doctors,
  selected,
}: {
  doctors: readonly { id: string; name: string }[];
  selected: string | null;
}) {
  const router = useRouter();
  const path = usePathname();
  const params = useSearchParams();
  return (
    <div className="mt-2 flex items-center gap-2">
      <label htmlFor="heatmap-doctor" className="text-sm text-muted-foreground">
        For
      </label>
      <select
        id="heatmap-doctor"
        value={selected ?? ""}
        onChange={(e) => {
          const next = new URLSearchParams(params.toString());
          if (e.target.value) next.set("doctor", e.target.value);
          else next.delete("doctor");
          router.push(`${path}?${next.toString()}`, { scroll: false });
        }}
        className="min-h-11 rounded-md border border-border bg-background px-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <option value="">Whole clinic</option>
        {doctors.map((d) => (
          <option key={d.id} value={d.id}>
            {d.name}
          </option>
        ))}
      </select>
    </div>
  );
}

export function DoctorSelect(props: {
  doctors: readonly { id: string; name: string }[];
  selected: string | null;
}) {
  return (
    <Suspense fallback={<div className="mt-2 min-h-11" />}>
      <Inner {...props} />
    </Suspense>
  );
}
