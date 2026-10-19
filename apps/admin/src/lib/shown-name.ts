import { properName } from "@/lib/patient-name";

/**
 * A patient's name as the API gave it. For a full view it is tidied; a viewer's minimised view is
 * already initials ("A. O."), which tidying would damage, so it is shown as received.
 */
export function shownName(
  name: string,
  view: "full" | "minimised" = "full",
): string {
  return view === "minimised" ? name : properName(name);
}
