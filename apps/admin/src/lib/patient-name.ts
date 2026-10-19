// Names arrive as typed on the booking form: stray spaces, all lower case or all capitals. Show
// them tidy without touching a name that already has mixed case (McDonald, de Souza).
export function properName(raw: string | null | undefined): string {
  const name = (raw ?? "").replace(/\s+/g, " ").trim();
  if (name === "") return "Name not given";
  if (name !== name.toLowerCase() && name !== name.toUpperCase()) return name;
  return name
    .toLowerCase()
    .replace(
      /(^|[\s'-])(\p{L})/gu,
      (_m, sep: string, ch: string) => sep + ch.toUpperCase(),
    );
}
