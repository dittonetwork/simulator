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

export function bigIntToString(obj: any): any {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === 'bigint') {
    return obj.toString();
  }

  if (Array.isArray(obj)) {
    return obj.map(item => bigIntToString(item));
  }

  if (typeof obj === 'object') {
    const newObj: { [key: string]: any } = {};
    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        newObj[key] = bigIntToString(obj[key]);
      }
    }
    return newObj;
  }

  return obj;
}
