/**
 * Map `items` through `func`, with at most `limit` calls outstanding.
 *
 * Bounded rather than a bare `Promise.all`: the callers here are file passes
 * over whole source trees, and handing tens of thousands of reads to the
 * thread pool at once buys no throughput while it does exhaust file handles.
 * Results come back in the order of `items`, not the order they settled, so a
 * digest taken over them is stable.
 */
export async function mapWithLimitAsync<T, R>(
	items: ReadonlyArray<T>,
	limit: number,
	func: (item: T, index: number) => Promise<R>,
): Promise<Array<R>> {
	const results: Array<R> = [];
	let next = 0;

	async function drainAsync(): Promise<void> {
		for (let index = next; index < items.length; index = next) {
			next = index + 1;
			// eslint-disable-next-line ts/no-non-null-assertion -- index is below items.length
			results[index] = await func(items[index]!, index);
		}
	}

	const workers = Math.min(Math.max(limit, 1), items.length);
	await Promise.all(Array.from({ length: workers }, async () => drainAsync()));
	return results;
}
