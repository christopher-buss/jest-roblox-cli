/**
 * Options for `mapWithLimitAsync`.
 * @template T
 * @template R
 */
export interface MapWithLimitOptions<T, R> {
	/** Maps one item, given its index. */
	readonly func: (item: T, index: number) => Promise<R>;
	/** The items to map. */
	readonly items: ReadonlyArray<T>;
	/** The most calls outstanding at once. */
	readonly limit: number;
}

/**
 * Map `items` through `func`, with at most `limit` calls outstanding.
 * @template T
 * @template R
 * @param options - The items, the mapper and the limit.
 * @param options.func - Maps one item.
 * @param options.items - The items to map.
 * @param options.limit - The most calls outstanding at once.
 * @returns The results, in the order of `items`.
 * @rejects Whatever `func` first rejects with.
 */
export async function mapWithLimitAsync<T, R>({
	func,
	items,
	limit,
}: MapWithLimitOptions<T, R>): Promise<Array<R>> {
	const results: Array<R> = [];
	let next = 0;

	async function drainAsync(): Promise<void> {
		for (let index = next; index < items.length; index = next) {
			next = index + 1;
			// oxlint-disable-next-line typescript/no-non-null-assertion -- index is below items.length
			results[index] = await func(items[index]!, index);
		}
	}

	const workers = Math.min(Math.max(limit, 1), items.length);
	await Promise.all(Array.from({ length: workers }, async () => drainAsync()));
	return results;
}
