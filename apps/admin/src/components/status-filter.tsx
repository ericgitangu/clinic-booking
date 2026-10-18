"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@clinic/ui/components/ui/select";
import { haptic } from "@clinic/ui/lib/haptics";
import { STATUSES, type StatusFilterValue } from "@/lib/filters";

const LABEL: Record<StatusFilterValue, string> = {
  all: "All appointments",
  booked: "Booked",
  cancelled: "Cancelled",
};

export function StatusFilter({ status }: { status: StatusFilterValue }) {
  const router = useRouter();
  const path = usePathname();
  const params = useSearchParams();

  function choose(value: string) {
    haptic("info");
    const next = new URLSearchParams(params.toString());
    next.set("status", value);
    next.delete("cursor");
    router.push(`${path}?${next.toString()}`);
  }

  return (
    <Select value={status} onValueChange={choose}>
      <SelectTrigger className="min-h-11 w-full sm:w-52" aria-label="Show">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {STATUSES.map((s) => (
          <SelectItem key={s} value={s}>
            {LABEL[s]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
