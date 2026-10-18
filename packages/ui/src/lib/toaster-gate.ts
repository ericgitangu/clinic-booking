// The toast library is about 25 KB that no page needs to paint, so it is not part of the first
// load. This small gate lets the code that raises a toast ask for the toaster, and run once the
// toaster is on the page, so a toast raised early (a confirmation page raises one as it opens) is
// shown, not lost.
let mounted = false;
const waiting: (() => void)[] = [];
const wanters = new Set<() => void>();

export function requestToaster(): void {
  for (const w of wanters) w();
}

export function onToasterRequested(fn: () => void): () => void {
  wanters.add(fn);
  return () => void wanters.delete(fn);
}

export function markToasterMounted(): void {
  mounted = true;
  for (const run of waiting.splice(0)) run();
}

export function whenToasterMounted(run: () => void): void {
  if (mounted) run();
  else waiting.push(run);
}
