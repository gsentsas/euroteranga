import { describe, expect, it } from 'vitest';
import { createMediaCache, mediaBatches, resolveMedia, type MediaBatchFetch } from './media.js';

const id = (index: number) => `01900000-0000-7000-8000-${String(index).padStart(12, '0')}`;
const ids = (count: number) => Array.from({ length: count }, (_, index) => id(index + 1));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

describe('media batches (MEDIA-1)', () => {
  it('deduplicates canonical ids and cuts batches of 50', () => {
    const batches = mediaBatches([...ids(120), id(1).toUpperCase(), id(2)]);
    expect(batches.map((batch) => batch.length)).toEqual([50, 50, 20]);
    expect(batches.flat()).toEqual(ids(120));
  });

  it('resolves several batches in parallel, keeps each result with its id, tolerates failures', async () => {
    const started: string[][] = [];
    const slow = deferred<ReadonlyMap<string, string> | null>();
    const fetch: MediaBatchFetch<string> = (batch) => {
      started.push(batch);
      if (batch.includes(id(1))) return slow.promise; // first batch: slow
      if (batch.includes(id(101))) return Promise.reject(new Error('timeout')); // third: fails
      return Promise.resolve(new Map(batch.map((value) => [value, `media ${value}`])));
    };
    const resolving = resolveMedia(ids(160), fetch);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The slow first batch does not hold the others back.
    expect(started).toHaveLength(4);
    slow.resolve(new Map([[id(1), 'media one']]));
    const found = await resolving;
    expect(found.get(id(1))).toBe('media one');
    expect(found.has(id(2))).toBe(false);
    expect(found.get(id(51))).toBe(`media ${id(51)}`);
    expect(found.has(id(101))).toBe(false); // failed batch: left out, nothing thrown
    expect(found.get(id(160))).toBe(`media ${id(160)}`);
  });

  it('never runs more batches at once than its concurrency', async () => {
    let inFlight = 0;
    let peak = 0;
    const fetch: MediaBatchFetch<boolean> = async (batch) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return new Map(batch.map((value) => [value, true]));
    };
    const found = await resolveMedia(ids(500), fetch, { concurrency: 3 });
    expect(found.size).toBe(500);
    expect(peak).toBe(3);
  });
});

describe('media cache of the OPS preview (MEDIA-1)', () => {
  it('marks absent only the ids of a batch that was actually requested', async () => {
    const requests: string[][] = [];
    const answers: Array<(value: ReadonlyMap<string, string>) => void> = [];
    let resolved = 0;
    const cache = createMediaCache<string>(
      (batch) => {
        requests.push(batch);
        return new Promise((resolve) => answers.push(resolve));
      },
      () => (resolved += 1),
    );
    const wanted = ids(80);
    cache.request(wanted);
    expect(requests.map((batch) => batch.length)).toEqual([50]);
    cache.request(wanted); // the first 50 are in flight: only the next ones are asked
    expect(requests[1]).toEqual(wanted.slice(50));
    cache.request(wanted); // everything is in flight: no request at all
    expect(requests).toHaveLength(2);

    answers[0]!(new Map([[id(1), 'first']]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(resolved).toBe(1);
    expect(cache.get(id(1))).toBe('first');
    expect(cache.get(id(2))).toBeNull(); // requested, not returned: absent
    expect(cache.get(id(51))).toBeUndefined(); // its own batch has not answered: unknown

    answers[1]!(new Map([[id(80), 'last']]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cache.get(id(80).toUpperCase())).toBe('last');
    expect(cache.get(id(51))).toBeNull();
  });

  it('caches nothing when a batch request fails, so it can be retried', async () => {
    let calls = 0;
    const cache = createMediaCache<string>(
      () => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new Error('network'))
          : Promise.resolve(new Map([[id(1), 'ok']]));
      },
      () => undefined,
    );
    cache.request([id(1)]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cache.get(id(1))).toBeUndefined();
    cache.request([id(1)]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cache.get(id(1))).toBe('ok');
  });
});
