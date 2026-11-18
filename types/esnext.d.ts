/// <reference lib="esnext.temporal" />
/// <reference lib="esnext.typedarrays" />

// better-typescript-lib's esnext replacement omits these Node 26 APIs.

declare global {
	interface Map<K, V> {
		getOrInsert(key: K, defaultValue: V): V;
		getOrInsertComputed(key: K, callback: (key: K) => V): V;
	}

	interface WeakMap<K extends WeakKey, V> {
		getOrInsert(key: K, defaultValue: V): V;
		getOrInsertComputed(key: K, callback: (key: K) => V): V;
	}
}

export {};
