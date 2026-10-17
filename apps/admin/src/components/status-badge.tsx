import { Badge } from "@clinic/ui/components/ui/badge";

export function StatusBadge({ status }: { status: "booked" | "cancelled" }) {
  return status === "booked" ? (
    <Badge variant="secondary">Booked</Badge>
  ) : (
    <Badge variant="destructive">Cancelled</Badge>
  );
}
