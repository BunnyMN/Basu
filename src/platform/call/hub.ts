/**
 * Who is waiting to hear that a call moved.
 *
 * A screen asks «anything after version 3?» and, when there is nothing yet,
 * is held open until there is — or until the wait runs out and it asks
 * again. This is the holding: a key (`call:<id>`, `guest:<id>`) and the
 * waiters on it, woken when a call changes.
 *
 * In memory, and so in one process. The API is one process; the scheduler,
 * which also ends calls (a ring nobody answered), wakes nobody, and its
 * waiters find out on their next ask — at most one wait later.
 */
const waiting = new Map<string, Set<() => void>>();

export function wake(...keys: string[]): void {
  for (const key of keys) {
    const set = waiting.get(key);
    if (!set) continue;
    waiting.delete(key);
    for (const resolve of set) resolve();
  }
}

/** Resolves when any key is woken, the time is up, or the asker went away. */
export function waitFor(keys: readonly string[], ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      for (const key of keys) {
        const set = waiting.get(key);
        set?.delete(finish);
        if (set?.size === 0) waiting.delete(key);
      }
      resolve();
    };
    const timer = setTimeout(finish, ms);
    timer.unref?.();
    if (signal?.aborted) return finish();
    signal?.addEventListener('abort', finish, { once: true });
    for (const key of keys) {
      let set = waiting.get(key);
      if (!set) waiting.set(key, (set = new Set()));
      set.add(finish);
    }
  });
}

export const callKey = (id: string) => `call:${id}`;
export const guestKey = (id: string) => `guest:${id}`;
