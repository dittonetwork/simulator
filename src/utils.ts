export function serializeIpfs(hash: string): string {
  if (!hash) return '';
  return hash.length <= 8 ? hash : `${hash.slice(0, 4)}...${hash.slice(-4)}`;
}

export async function runConcurrent<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  const executing: Promise<void>[] = [];

  for (const item of items) {
    const p: Promise<void> = fn(item)
      .then((res) => {
        results.push(res);
      })
      .finally(() => {
        const idx = executing.indexOf(p);
        if (idx !== -1) executing.splice(idx, 1);
      });

    executing.push(p);
    if (executing.length >= limit) {
      await Promise.race(executing);
    }
  }

  await Promise.all(executing);
  return results;
}
