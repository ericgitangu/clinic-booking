"use client";

import { useCallback, useEffect, useRef } from "react";
import { StreamController, type ControllerOptions } from "./controller";

export type UseEventStreamOptions<T> = Omit<
  ControllerOptions<T>,
  "onStatus"
> & {
  /** Off while the page is idle or the feature is not wanted; turning it off closes the stream. */
  enabled: boolean;
  /** A new value restarts the stream (a different channel). */
  channelKey: string;
  onStatus(status: import("./controller").StreamStatus): void;
};

/**
 * Keeps one push stream open while `enabled`. Transport only: it knows nothing about slots. The
 * start is deferred by a tick so React StrictMode's mount, unmount, mount in development cancels
 * the first start before it mints a token: one token per real mount, not two.
 */
export function useEventStream<T>(opts: UseEventStreamOptions<T>) {
  const latest = useRef(opts);
  latest.current = opts;
  const controller = useRef<StreamController<T> | null>(null);

  useEffect(() => {
    if (!opts.enabled) return;
    const c = new StreamController<T>({
      getToken: (s) => latest.current.getToken(s),
      schema: { safeParse: (v) => latest.current.schema.safeParse(v) },
      onEvent: (e, id) => latest.current.onEvent(e, id),
      onStatus: (s) => latest.current.onStatus(s),
      onConnected: () => latest.current.onConnected?.(),
      shouldReconnect: () => latest.current.shouldReconnect(),
      fetchImpl: latest.current.fetchImpl,
      backoff: latest.current.backoff,
      refusedWaitMs: latest.current.refusedWaitMs,
    });
    controller.current = c;
    const t = setTimeout(() => c.start(), 0);
    return () => {
      clearTimeout(t);
      c.stop();
      controller.current = null;
    };
  }, [opts.enabled, opts.channelKey]);

  const poke = useCallback(() => controller.current?.poke(), []);
  return { poke };
}
