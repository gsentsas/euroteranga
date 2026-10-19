/**
 * Batched resolution of media ids (MEDIA-1): the public media API answers at
 * most 50 ids per request. Ids are UUIDs, compared in their canonical
 * lowercase form.
 */
export const MEDIA_BATCH_SIZE = 50;

/** Batches resolved at the same time by the website: bounded, never a storm. */
export const MEDIA_BATCH_CONCURRENCY = 4;

/** Images found by one batch request, keyed by canonical id; null when it failed. */
export type MediaBatchFetch<V> = (batch: string[]) => Promise<ReadonlyMap<string, V> | null>;

export const canonicalMediaId = (id: string) => id.toLowerCase();

/** Distinct canonical ids, in batches of at most `size`. */
export function mediaBatches(ids: Iterable<string>, size = MEDIA_BATCH_SIZE): string[][] {
  const unique = [...new Set([...ids].map(canonicalMediaId))];
  const batches: string[][] = [];
  for (let start = 0; start < unique.length; start += size) {
    batches.push(unique.slice(start, start + size));
  }
  return batches;
}

/**
 * Resolves every id, at most `concurrency` batches in flight. A batch that
 * fails or is slow only affects its own images: the others are not waiting
 * behind it, and nothing is thrown.
 */
export async function resolveMedia<V>(
  ids: Iterable<string>,
  fetchBatch: MediaBatchFetch<V>,
  options: { size?: number; concurrency?: number } = {},
): Promise<Map<string, V>> {
  const batches = mediaBatches(ids, options.size);
  const found = new Map<string, V>();
  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      const batch = batches[next]!;
      next += 1;
      const result = await fetchBatch(batch).catch(() => null);
      for (const [id, value] of result ?? []) found.set(canonicalMediaId(id), value);
    }
  };
  const workers = Math.min(options.concurrency ?? MEDIA_BATCH_CONCURRENCY, batches.length);
  await Promise.all(Array.from({ length: workers }, worker));
  return found;
}

export interface MediaCache<V> {
  /** The image, null when the API answered without it, undefined while unknown. */
  get(id: string): V | null | undefined;
  /** Requests the first batch of ids that are neither known nor in flight. */
  request(ids: Iterable<string>): void;
}

/**
 * Client-side cache (OPS preview): one batch at a time, and only the ids of
 * a batch that was actually sent are marked absent. `onResolved` runs after
 * each answered batch, so the caller can request the next missing ids.
 */
export function createMediaCache<V>(
  fetchBatch: MediaBatchFetch<V>,
  onResolved: () => void,
  size = MEDIA_BATCH_SIZE,
): MediaCache<V> {
  const known = new Map<string, V | null>();
  const pending = new Set<string>();
  return {
    get: (id) => known.get(canonicalMediaId(id)),
    request(ids) {
      const missing = [...new Set([...ids].map(canonicalMediaId))].filter(
        (id) => !known.has(id) && !pending.has(id),
      );
      const batch = missing.slice(0, size);
      if (batch.length === 0) return;
      batch.forEach((id) => pending.add(id));
      void fetchBatch(batch)
        .catch(() => null)
        .then((result) => {
          batch.forEach((id) => pending.delete(id));
          // A failed request caches nothing: the ids stay unknown and can be retried.
          if (!result) return;
          for (const id of batch) known.set(id, result.get(id) ?? null);
          onResolved();
        });
    },
  };
}
