// Narrows vitest's own matchers, which ship as `<E>(expected: E) => void` and
// therefore accept any argument, and its asymmetric matcher factories, which
// return `any`. Unlike `jest-extended.d.ts` this needs no `paths` swap: the
// members live on `JestAssertion`, `CustomMatcher` and
// `AsymmetricMatchersContaining`, all of them *bases* of `Assertion` and
// `ExpectStatic`, so a merged declaration on the derived interface replaces
// the inherited member instead of adding an overload beside it.
//
// Only an inherited member can be replaced. Redeclaring an own member is
// TS2717 and the original type wins, which leaves these as vitest ships them:
// `toHaveBeenCalledExactlyOnceWith`, `toHaveResolvedWith`,
// `toHaveLastResolvedWith`, `toHaveNthResolvedWith`, `resolves`, `rejects`,
// `expect.anything`, `expect.any`, and everything under `expect.not`.
//
// Each matcher takes its expectation as `E extends <narrowed>` rather than as
// the narrowed type. `expect.any` and `expect.anything` return `any` and are
// two of the members that cannot be replaced, so a parameter of the narrowed
// type would turn every one of their call sites into a `no-unsafe-argument`
// error. A constraint is not a contextual type, which costs two things: an
// excess property in an object literal no longer reports, and a call that
// infers from the parameter (`fromPartial`, a bare arrow) needs its type
// argument written out.

/* eslint-disable ts/no-unnecessary-type-parameters -- see the note above */

import type { DeeplyAllowMatchers, MockInstance } from "vitest";

/**
 * Two subjects carry no information to check an expectation against, so both
 * widen to `unknown` and every matcher below stays permissive for them:
 *
 * - A promise. `.resolves` / `.rejects` keep `T` as the promise rather than
 *   its settled value, and neither of those two members can be replaced.
 * - `JSONValue`, what `JSON.parse` returns. It says only "some JSON", and a
 *   plain record is never assignable to `JSONObject` for want of an index
 *   signature, so every expectation against one would be a false positive.
 */
type Subject<T> =
	// Both tests are on the whole of `T`, hence the tuple wrappers: a bare
	// conditional distributes over a union, and `JSONValue` is one.
	[T] extends [Promise<unknown>] ? unknown : [JSONValue] extends [T] ? unknown : T;

/** `AsymmetricMatcher` itself is not exported; recover it from one that is. */
type AnyMatcher = Exclude<DeeplyAllowMatchers<symbol>, symbol>;

/** `toBe` compares by identity, so only the whole value can be a matcher. */
type Identical<T> = AnyMatcher | Subject<T>;

/**
 * Vitest's own `DeeplyAllowMatchers`, except that an array position also takes
 * a `ReadonlyArray`. Deep equality ignores `readonly`, so refusing one is
 * noise.
 */
type Deep<T> =
	T extends ReadonlyArray<infer E>
		? AnyMatcher | ReadonlyArray<Deep<E>> | T
		: T extends object
			? AnyMatcher | T | { [K in keyof T]: Deep<T[K]> }
			: AnyMatcher | T;

type Expected<T> = Deep<Subject<T>>;

type ArrayElement<T> = Subject<T> extends ReadonlyArray<infer E> ? E : unknown;

/**
 * `toContain` walks a string by substring and any other iterable by element.
 */
type Contained<T> =
	Subject<T> extends string
		? string
		: Subject<T> extends ReadonlyArray<infer E>
			? E
			: Subject<T> extends Iterable<infer E>
				? E
				: unknown;

type Callable<T> =
	Subject<T> extends MockInstance<infer P>
		? P
		: Subject<T> extends (...args: Array<any>) => any
			? Subject<T>
			: never;

type CallArgs<T> =
	Callable<T> extends (...args: infer A) => any
		? { [I in keyof A]: Deep<A[I]> }
		: Callable<T> extends new (...args: infer A) => any
			? { [I in keyof A]: Deep<A[I]> }
			: Array<unknown>;

type CallReturn<T> = Callable<T> extends (...args: Array<any>) => infer R ? R : unknown;

/**
 * Recursion stops at the built-ins whose shape is methods rather than data —
 * mapping over one drops those methods and would reject a valid argument.
 */
type DeepPartial<T> =
	T extends ReadonlyArray<infer E>
		? Array<DeepPartial<E>>
		: T extends ((...args: Array<any>) => any) | Date | Map<any, any> | RegExp | Set<any>
			? T
			: T extends object
				? { [K in keyof T]?: DeepPartial<T[K]> }
				: T;

/**
 * The property name stays unconstrained: `.not.toHaveProperty(name)` asserts
 * that the name is absent, so rejecting a name the type does not declare would
 * outlaw the matcher's main use. Only the value narrows, and only when the name
 * does resolve to a declared property.
 */
type PropertyValue<T, K> =
	NonNullable<Subject<T>> extends infer S ? (K extends keyof S ? S[K] : unknown) : unknown;

type Thrown =
	| (abstract new (...args: Array<any>) => Error)
	| AnyMatcher
	| Error
	| RegExp
	| string
	| { message: RegExp | string };

declare module "vitest" {
	// Narrowing an inherited member is by definition incompatible with the
	// base's `<E>(expected: E)`, so the merge reports TS2430 here. The
	// replacement still wins at every call site.
	// @ts-expect-error -- deliberate narrowing of inherited matchers
	interface Assertion<T = any> {
		toBe: <E extends Identical<T>>(expected: E) => void;
		toBeInstanceOf: (expected: abstract new (...args: Array<any>) => any) => void;
		toBeOneOf: <E extends ReadonlyArray<Expected<T>> | ReadonlySet<Expected<T>>>(
			sample: E,
		) => void;
		toContain: <E extends Contained<T>>(item: E) => void;
		toContainEqual: <E extends Deep<ArrayElement<T>>>(item: E) => void;
		toEqual: <E extends Expected<T>>(expected: E) => void;
		toHaveBeenCalledWith: <E extends CallArgs<T>>(...args: E) => void;
		toHaveBeenLastCalledWith: <E extends CallArgs<T>>(...args: E) => void;
		toHaveBeenNthCalledWith: <E extends CallArgs<T>>(n: number, ...args: E) => void;
		toHaveLastReturnedWith: <E extends Deep<CallReturn<T>>>(value: E) => void;
		toHaveNthReturnedWith: <E extends Deep<CallReturn<T>>>(nthCall: number, value: E) => void;
		toHaveProperty<K extends number | string, E extends Deep<PropertyValue<T, K>>>(
			property: K,
			value?: E,
		): void;
		toHaveProperty(property: Array<number | string>, value?: unknown): void;
		toHaveReturnedWith: <E extends Deep<CallReturn<T>>>(value: E) => void;
		toMatchObject: <E extends Deep<DeepPartial<Subject<T>>>>(expected: E) => void;
		toSatisfy: (matcher: (value: Subject<T>) => boolean, message?: string) => void;
		toStrictEqual: <E extends Expected<T>>(expected: E) => void;
		toThrow: <E extends Thrown>(expected?: E) => void;
	}

	// @ts-expect-error -- deliberate narrowing of inherited matcher factories
	interface ExpectStatic {
		arrayContaining: <E = unknown>(expected: ReadonlyArray<Deep<E>>) => AnyMatcher;
		closeTo: (expected: number, precision?: number) => AnyMatcher;
		objectContaining: <E = any>(expected: Deep<E>) => AnyMatcher;
		schemaMatching: (schema: unknown) => AnyMatcher;
		stringContaining: (expected: string) => AnyMatcher;
		stringMatching: (expected: RegExp | string) => AnyMatcher;
		toBeOneOf: <E>(sample: ReadonlyArray<E> | ReadonlySet<E>) => AnyMatcher;
		toSatisfy: (matcher: (value: any) => boolean, message?: string) => AnyMatcher;
	}
}
