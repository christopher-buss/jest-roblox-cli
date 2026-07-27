/**
 * Maps an input object type to the shape `omitUndefined` returns: keys that
 * could hold `undefined` become optional and lose it, the rest pass through
 * unchanged.
 */
type OmitUndefined<T> = {
	[K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
} & {
	[K in keyof T as undefined extends T[K] ? never : K]: T[K];
};

/**
 * Drops the entries whose value is `undefined`. Lets a builder assemble every
 * field it resolved in one literal — including the ones that resolved to
 * nothing — and still spread into an `exactOptionalPropertyTypes` target, which
 * rejects an explicit `undefined` where an optional property is declared. The
 * result type carries the invariant, so call sites need no cast.
 */
export function omitUndefined<T extends object>(value: T): OmitUndefined<T>;
export function omitUndefined(value: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
	);
}
