/**
 * Sliding-window limiter, in memory.
 *
 * Deliberately not backed by Mongo or Redis: this service runs as a single
 * process, and the thing being limited is how often someone can ask for a
 * sign-in code — cheap to check, and no great loss if a restart forgets. If
 * this ever runs behind more than one instance, move the counters to a shared
 * store, or each instance will independently allow the full quota.
 */
const windows = new Map<string, number[]>();

export type RateLimitResult = { allowed: boolean; retryAfterSeconds: number };

export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  const cutoff = now - windowMs;
  const hits = (windows.get(key) ?? []).filter((t) => t > cutoff);

  if (hits.length >= limit) {
    const oldest = hits[0]!;
    windows.set(key, hits);
    return { allowed: false, retryAfterSeconds: Math.ceil((oldest + windowMs - now) / 1000) };
  }

  hits.push(now);
  windows.set(key, hits);
  return { allowed: true, retryAfterSeconds: 0 };
}

/** Keeps the map from growing without bound on a long-running process. */
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [key, hits] of windows) {
    const live = hits.filter((t) => t > cutoff);
    if (live.length) windows.set(key, live);
    else windows.delete(key);
  }
}, 10 * 60 * 1000).unref();
