// Times in staff emails: "Tuesday 20 October, 09:00" and "East Africa Time (GMT+03:00)", the same
// wording as the patient app's emails. The appointment's own zone is used when it is given; the
// clinic keeps Nairobi time otherwise.
import { CLINIC_TZ } from "@/lib/clinic-time";

export function formatWhen(iso: string, zone: string = CLINIC_TZ): string {
  const at = new Date(iso);
  const day = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(at);
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(at);
  return `${day}, ${time}`;
}

// The zone's name and its offset at that instant, so a reader in another zone knows which clock it is.
export function zoneLabel(iso: string, zone: string = CLINIC_TZ): string {
  const at = new Date(iso);
  const part = (style: "long" | "longOffset") =>
    new Intl.DateTimeFormat("en-GB", { timeZone: zone, timeZoneName: style })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName")?.value ?? zone;
  return `${part("long")} (${part("longOffset")})`;
}
