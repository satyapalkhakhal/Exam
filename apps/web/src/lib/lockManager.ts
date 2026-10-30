// src/lib/lockManager.ts
// Why: the marking lock is acquired/released from a React effect, which StrictMode (and fast
// navigation) runs as acquire(A1) -> release(A1) -> acquire(A2). A release for an older
// acquisition must never delete the lock a newer acquisition just took, so releases are
// deferred one tick and skipped when a newer generation exists for the same attempt.
// The server lock lasts 30 minutes from its last touch; a marking page left open while
// the evaluator reads long answers renews it (re-POST, which the holder may repeat and
// which moves the expiry) every LOCK_RENEW_MS, so submit never meets an expired lock.

/** How often an open marking page renews its lock (the server's lock lasts 30 min). */
export const LOCK_RENEW_MS = 10 * 60_000;

export interface LockManagerDeps<T> {
  post: (id: string) => Promise<T>;
  del: (id: string) => void;
  /** Defers a release so a synchronous re-acquire can supersede it. */
  defer?: (fn: () => void) => void;
}

export function createLockManager<T>({ post, del, defer = (fn) => void setTimeout(fn, 0) }: LockManagerDeps<T>) {
  const gen = new Map<string, number>();
  const pending = new Map<string, Promise<unknown>>();

  return {
    acquire(id: string): { token: number; result: Promise<T> } {
      const token = (gen.get(id) ?? 0) + 1;
      gen.set(id, token);
      const result = post(id);
      pending.set(id, result.catch(() => undefined));
      return { token, result };
    },
    /** Normal release (unmount): skipped if a newer acquire exists by the time it runs. */
    release(id: string, token: number): void {
      defer(() => {
        const settle = pending.get(id) ?? Promise.resolve();
        void settle.then(() => {
          if (gen.get(id) === token) del(id);
        });
      });
    },
    /** Re-POST the lock for the current acquisition; null (no request) once superseded. */
    renew(id: string, token: number): Promise<T> | null {
      if (gen.get(id) !== token) return null;
      return post(id);
    },
    /** pagehide: no time to wait, send now unless superseded. */
    releaseNow(id: string, token: number): void {
      if (gen.get(id) === token) del(id);
    },
  };
}
