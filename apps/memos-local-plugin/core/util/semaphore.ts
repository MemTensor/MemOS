export interface Semaphore {
  acquire(): Promise<() => void>;
}

export function createSemaphore(max: number): Semaphore {
  const limit = Math.max(1, Math.floor(max));
  let current = 0;
  const waiters: Array<() => void> = [];

  return {
    async acquire() {
      if (current < limit) {
        current++;
        return release;
      }
      return new Promise<() => void>((resolve) => {
        waiters.push(() => {
          current++;
          resolve(release);
        });
      });
    },
  };

  function release() {
    current = Math.max(0, current - 1);
    const next = waiters.shift();
    if (next) next();
  }
}
