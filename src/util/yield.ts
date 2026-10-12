const channel = typeof MessageChannel !== 'undefined' ? new MessageChannel() : null;
const queue: (() => void)[] = [];
if (channel) channel.port1.onmessage = () => queue.shift()?.();

/**
 * Yields to the event loop without timer clamping: chained setTimeout calls are throttled to
 * 4 ms, and to once per second on hidden pages, which would stall GPU polling loops.
 */
export function yieldTask(): Promise<void> {
  if (!channel) return new Promise((r) => setTimeout(r, 0));
  return new Promise((r) => {
    queue.push(r);
    channel.port2.postMessage(0);
  });
}
