import {
  BanIcon,
  CircleCheckIcon,
  UserCheckIcon,
  UserXIcon,
} from "lucide-react";
import { Badge } from "@clinic/ui/components/ui/badge";

export type VisitStatus = "booked" | "arrived" | "no_show" | "cancelled";

/** The one status a visit shows: the desk's mark wins over "booked". */
export function visitStatus(a: {
  status: "booked" | "cancelled";
  attendance?: "arrived" | "no_show" | null;
}): VisitStatus {
  return a.status === "cancelled" ? "cancelled" : (a.attendance ?? "booked");
}

const LABEL: Record<VisitStatus, string> = {
  booked: "Booked",
  arrived: "Arrived",
  no_show: "No-show",
  cancelled: "Cancelled",
};

// Words and an icon of a different shape as well as colour, so the status reads without hue.
export function StatusBadge({
  status,
  attendance,
}: {
  status: "booked" | "cancelled" | VisitStatus;
  attendance?: "arrived" | "no_show" | null;
}) {
  const s: VisitStatus =
    status === "booked" || status === "cancelled"
      ? visitStatus({ status, attendance })
      : status;
  const icon =
    s === "booked" ? (
      <CircleCheckIcon aria-hidden />
    ) : s === "arrived" ? (
      <UserCheckIcon aria-hidden />
    ) : s === "no_show" ? (
      <UserXIcon aria-hidden />
    ) : (
      <BanIcon aria-hidden />
    );
  const variant =
    s === "cancelled"
      ? "destructive"
      : s === "no_show"
        ? "outline"
        : "secondary";
  return (
    <Badge variant={variant} className="gap-1">
      {icon} {LABEL[s]}
    </Badge>
  );
}
