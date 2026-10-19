import { cache } from "react";

// One map per request (React's cache() is scoped to the request being rendered). A read made twice
// while one page renders is asked of the API once. Only reads go through here, never writes, and
// the key names the operation, the signed caller and every argument, so a result is never shared
// between people or between different questions.
const perRequest = cache(() => new Map<string, Promise<unknown>>());

export function memo<T>(
  key: string,
  make: () => Promise<T>,
  store: Map<string, Promise<unknown>> = perRequest(),
): Promise<T> {
  const hit = store.get(key);
  if (hit) return hit as Promise<T>;
  const fresh = make();
  store.set(key, fresh);
  return fresh;
}

/** The key for a read: operation, who asks, and the arguments. */
export function readKey(
  operation: string,
  caller: { sub: string; role: string } | null,
  args: unknown,
): string {
  return `${operation}|${caller ? `${caller.sub}:${caller.role}` : "public"}|${JSON.stringify(args)}`;
}
