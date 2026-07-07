import { useEffect } from 'react';

/**
 * Shared polling loop for the order hooks: runs `tick` immediately, then every
 * `intervalMs` for as long as `tick` resolves true. Cancels cleanly on unmount
 * or dependency change; `isActive()` lets the tick guard its own setState
 * calls against a stale run. Internal — not exported from the package.
 */
export function usePoll(
  enabled: boolean,
  intervalMs: number,
  tick: (isActive: () => boolean) => Promise<boolean>,
): void {
  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const isActive = () => !cancelled;

    const run = async () => {
      const keepPolling = await tick(isActive);
      if (cancelled) return;
      if (keepPolling) timer = setTimeout(run, intervalMs);
    };
    void run();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [enabled, intervalMs, tick]);
}
