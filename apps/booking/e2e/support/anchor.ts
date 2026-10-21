// The Tuesday every week-based helper counts from: the first Tuesday at least ten days out, taken
// once per process. Reading the date on every call would let a run that crosses midnight in
// Nairobi (21:00 UTC) move the anchor under itself, and two helpers could then name the same week.
// Self-contained on purpose: api.ts imports this, so it must not import api.ts back.
const nairobiDay = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Africa/Nairobi",
});
const plusDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000)
    .toISOString()
    .slice(0, 10);
const isTuesday = (day: string) =>
  new Date(`${day}T12:00:00Z`).getUTCDay() === 2;

export const ANCHOR_DAY: string = (() => {
  const start = nairobiDay.format(new Date());
  let d = 10;
  while (!isTuesday(plusDays(start, d))) d++;
  return plusDays(start, d);
})();
