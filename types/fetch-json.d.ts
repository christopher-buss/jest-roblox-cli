/// <reference path="./vitest.d.ts" />

// `JSONValue` is global via better-typescript-lib's es5 lib (loaded by
// `libReplacement: true`).
//
// `Response` / `Request` come from `@types/node`'s `web-globals/fetch.d.ts`,
// which re-exports `undici-types`'s `BodyMixin.json: () => Promise<unknown>`.
// Augmenting the global interfaces here adds a `json` method whose signature
// the checker resolves over the inherited `unknown` property.
//
// The trailing `export {}` makes this file a module — required for both
// `declare global` blocks and `declare module` augmentations to take effect.

declare global {
	interface Response {
		json(): Promise<JSONValue>;
	}

	interface Request {
		json(): Promise<JSONValue>;
	}
}

export {};
