// Simple async semaphore. Bounds the number of concurrent in-flight async tasks.
//
// Usage:
//   const sem = createSemaphore(10);
//   await sem.run(async () => { ... });
//
// Or low-level:
//   const release = await sem.acquire();
//   try { ... } finally { release(); }

export const createSemaphore = (max) => {
  if (!Number.isInteger(max) || max < 1) throw new Error("createSemaphore: max must be a positive integer");
  let available = max;
  const waiters = [];

  const tryGrant = () => {
    while (available > 0 && waiters.length > 0) {
      available--;
      const grant = waiters.shift();
      grant();
    }
  };

  const acquire = () =>
    new Promise((resolve) => {
      const release = () => {
        available++;
        tryGrant();
      };
      waiters.push(() => resolve(release));
      tryGrant();
    });

  const run = async (fn) => {
    const release = await acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  };

  const stats = () => ({ max, available, waiting: waiters.length });

  return { acquire, run, stats };
};
