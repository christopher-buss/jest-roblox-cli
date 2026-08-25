// Replaces `jest-extended`'s bundled `types/index.d.ts` wholesale, via the
// `paths` entry in `tsconfig.node.json`. Node still loads the real package at
// runtime; only type resolution is redirected.
//
// The package declares `namespace jest { interface Matchers<R> }` with one type
// parameter and permissive generic signatures. This replacement adds the
// asserted value as `T`, which keeps matcher arguments subject-aware, and
// connects it directly to Vitest's `Matchers<R, T>` extension point. Importing
// the package's declarations would add overloads that silently accept invalid
// arguments through `any`/`unknown` fallbacks.
//
// Matchers vitest implements itself (`toHaveBeenCalledBefore`, `-After`,
// `-Once`, `-ExactlyOnceWith`, `toBeNaN`) are omitted: they are declared on
// vitest's own `Assertion`, which shadows anything declared here. Matchers not
// declared here fail loudly at the call site with TS2339 rather than going
// silently untyped.

import "vitest";

/**
 * A direct assertion on a Promise has no settled subject. `.resolves` supplies
 * Vitest's awaited subject type; `.rejects` deliberately supplies `unknown`.
 */
type Subject<T> = T extends Promise<unknown> ? unknown : T;

type ArrayElement<T> = Subject<T> extends ReadonlyArray<infer E> ? E : unknown;

type ObjectKey<T> = keyof Subject<T>;

type ObjectValue<T> = Subject<T>[keyof Subject<T>];

interface JestExtendedMatchers<R, T = unknown> {
	/** Use `.toBeAfter` when checking if a date occurs after `date`. */
	toBeAfter(date: Date): R;

	/**
	 * Use `.toBeAfterOrEqualTo` when checking if a date equals to or occurs
	 * after `date`.
	 */
	toBeAfterOrEqualTo(date: Date): R;

	/** Use `.toBeArray` when checking if a value is an `Array`. */
	toBeArray(): R;

	/**
	 * Use `.toBeArrayOfSize` when checking if a value is an `Array` of size
	 * x.
	 */
	toBeArrayOfSize(x: number): R;

	/** Use `.toBeBefore` when checking if a date occurs before `date`. */
	toBeBefore(date: Date): R;

	/**
	 * Use `.toBeBeforeOrEqualTo` when checking if a date equals to or
	 * occurs before `date`.
	 */
	toBeBeforeOrEqualTo(date: Date): R;

	/**
	 * Use `.toBeBetween` when checking if a date occurs between `startDate`
	 * and `endDate`.
	 */
	toBeBetween(startDate: Date, endDate: Date): R;

	/** Use `.toBeBigInt` when checking if a value is a `BigInt`. */
	toBeBigInt(): R;

	/** Use `.toBeBoolean` when checking if a value is a `Boolean`. */
	toBeBoolean(): R;

	/** Use `.toBeDate` when checking if a value is a `Date`. */
	toBeDate(): R;

	/**
	 * Use `.toBeDateString` when checking if a value is a valid date
	 * string.
	 */
	toBeDateString(): R;

	/**
	 * Use `.toBeEmpty` when checking if a String '', Array [], Object {} or
	 * Iterable (i.e. Map, Set) is empty.
	 */
	toBeEmpty(): R;

	/**
	 * Use `.toBeEmptyObject` when checking if a value is an empty
	 * `Object`.
	 */
	toBeEmptyObject(): R;

	/**
	 * Use `.toBeEven` when checking if a value is an even `Number` or
	 * `BigInt`.
	 */
	toBeEven(): R;

	/** Use `.toBeExtensible` when checking if an object is extensible. */
	toBeExtensible(): R;

	/** Use `.toBeFalse` when checking a value is equal (===) to `false`. */
	toBeFalse(): R;

	/**
	 * Use `.toBeFinite` when checking if a value is a `Number`, not `NaN`
	 * or `Infinity`, or a `BigInt`.
	 */
	toBeFinite(): R;

	/** Use `.toBeFrozen` when checking if an object is frozen. */
	toBeFrozen(): R;

	/** Use `.toBeFunction` when checking if a value is a `Function`. */
	toBeFunction(): R;

	/**
	 * Use `.toBeHexadecimal` when checking if a value is a valid HTML hex
	 * color.
	 */
	toBeHexadecimal(): R;

	/**
	 * Use `.toBeInRange` when checking if an array has elements in range
	 * min (inclusive) and max (exclusive).
	 */
	toBeInRange(min: bigint | number, max: bigint | number): R;

	/** Use `.toBeInteger` when checking if a value is an integer. */
	toBeInteger(): R;

	/**
	 * Use `.toBeNegative` when checking if a value is a negative `Number`
	 * or `BigInt`.
	 */
	toBeNegative(): R;

	/** Use `.toBeNil` when checking a value is `null` or `undefined`. */
	toBeNil(): R;

	/**
	 * Use `.toBeNumber` when checking if a value is a `Number` or
	 * `BigInt`.
	 */
	toBeNumber(): R;

	/** Use `.toBeObject` when checking if a value is an `Object`. */
	toBeObject(): R;

	/**
	 * Use `.toBeOdd` when checking if a value is an odd `Number` or
	 * `BigInt`.
	 */
	toBeOdd(): R;

	/**
	 * Use `.toBeOneOf` when checking if a value is a member of a given
	 * Array.
	 */
	toBeOneOf(members: ReadonlyArray<Subject<T>>): R;

	/**
	 * Use `.toBePositive` when checking if a value is a positive `Number`
	 * or `BigInt`.
	 */
	toBePositive(): R;

	/** Use `.toBeSealed` when checking if an object is sealed. */
	toBeSealed(): R;

	/** Use `.toBeString` when checking if a value is a `String`. */
	toBeString(): R;

	/** Use `.toBeSymbol` when checking if a value is a `Symbol`. */
	toBeSymbol(): R;

	/** Use `.toBeTrue` when checking a value is equal (===) to `true`. */
	toBeTrue(): R;

	/** Use `.toBeValidDate` when checking if a value is a `valid Date`. */
	toBeValidDate(): R;

	/**
	 * Use `.toBeWithin` when checking if a number is in between the given
	 * bounds of: start (inclusive) and end (exclusive).
	 */
	toBeWithin(start: number, end: number): R;

	/** Use `.toChange` when checking if a value has changed. */
	toChange(checker: () => unknown): R;

	/** Use `.toChangeBy` when checking if a value changed by an amount. */
	toChangeBy(checker: () => bigint | number, by?: bigint | number): R;

	/**
	 * Use `.toChangeTo` when checking if a value changed to a specific
	 * value.
	 */
	toChangeTo<E = unknown>(checker: () => E, to: E): R;

	/**
	 * Use `.toContainAllEntries` when checking if an object only contains
	 * all the provided entries.
	 */
	toContainAllEntries(entries: ReadonlyArray<readonly [ObjectKey<T>, ObjectValue<T>]>): R;

	/**
	 * Use `.toContainAllKeys` when checking if an object only contains all
	 * of the provided keys.
	 */
	toContainAllKeys(keys: ReadonlyArray<ObjectKey<T>>): R;

	/**
	 * Use `.toContainAllValues` when checking if an object only contains
	 * all of the provided values.
	 */
	toContainAllValues(values: ReadonlyArray<ObjectValue<T>>): R;

	/**
	 * Use `.toContainAnyEntries` when checking if an object contains at
	 * least one of the provided entries.
	 */
	toContainAnyEntries(entries: ReadonlyArray<readonly [ObjectKey<T>, ObjectValue<T>]>): R;

	/**
	 * Use `.toContainAnyKeys` when checking if an object contains at least
	 * one of the provided keys.
	 */
	toContainAnyKeys(keys: ReadonlyArray<ObjectKey<T>>): R;

	/**
	 * Use `.toContainAnyValues` when checking if an object contains at
	 * least one of the provided values.
	 */
	toContainAnyValues(values: ReadonlyArray<ObjectValue<T>>): R;

	/**
	 * Use `.toContainEntries` when checking if an object contains all of
	 * the provided entries.
	 */
	toContainEntries(entries: ReadonlyArray<readonly [ObjectKey<T>, ObjectValue<T>]>): R;

	/**
	 * Use `.toContainEntry` when checking if an object contains the
	 * provided entry.
	 */
	toContainEntry(entry: readonly [ObjectKey<T>, ObjectValue<T>]): R;

	/**
	 * Use `.toContainKey` when checking if an object contains the provided
	 * key.
	 */
	toContainKey(key: ObjectKey<T>): R;

	/**
	 * Use `.toContainKeys` when checking if an object has all of the
	 * provided keys.
	 */
	toContainKeys(keys: ReadonlyArray<ObjectKey<T>>): R;

	/**
	 * Use `.toContainValue` when checking if an object contains the
	 * provided value.
	 */
	toContainValue(value: ObjectValue<T>): R;

	/**
	 * Use `.toContainValues` when checking if an object contains all of the
	 * provided values.
	 */
	toContainValues(values: ReadonlyArray<ObjectValue<T>>): R;

	/**
	 * Use `.toEndWith` when checking if a `String` ends with a given
	 * `String` suffix.
	 */
	toEndWith(suffix: string): R;

	/**
	 * Use `.toEqualCaseInsensitive` when checking if a string is equal
	 * (===) to another ignoring the casing of both strings.
	 */
	toEqualCaseInsensitive(string: string): R;

	/**
	 * Use `.toEqualIgnoringWhitespace` when checking if a `String` is equal
	 * (===) to given `String` ignoring white-space.
	 */
	toEqualIgnoringWhitespace(string: string): R;

	/**
	 * Use `.toInclude` when checking if a `String` includes the given
	 * `String` substring.
	 */
	toInclude(substring: string): R;

	/**
	 * Use `.toIncludeAllMembers` when checking if an `Array` contains all
	 * the same members of a given set.
	 */
	toIncludeAllMembers(members: ReadonlyArray<ArrayElement<T>>): R;

	/**
	 * Use `.toIncludeAllPartialMembers` when checking if an `Array`
	 * contains all the same partial members of a given set.
	 */
	toIncludeAllPartialMembers(members: ReadonlyArray<Partial<ArrayElement<T>>>): R;

	/**
	 * Use `.toIncludeAnyMembers` when checking if an `Array` contains any
	 * of the members of a given set.
	 */
	toIncludeAnyMembers(members: ReadonlyArray<ArrayElement<T>>): R;

	/**
	 * Use `.toIncludeMultiple` when checking if a `String` includes all of
	 * the given substrings.
	 */
	toIncludeMultiple(substring: ReadonlyArray<string>): R;

	/**
	 * Use `.toIncludeRepeated` when checking if a `String` includes the
	 * given `String` substring the correct number of times.
	 */
	toIncludeRepeated(substring: string, times: number): R;

	/**
	 * Use `.toIncludeSameMembers` when checking if two arrays contain equal
	 * values, in any order.
	 */
	toIncludeSameMembers(members: ReadonlyArray<ArrayElement<T>>): R;

	/**
	 * Use `.toIncludeSamePartialMembers` when checking if an `Array`
	 * contains exactly the same partial members as a given set, in any
	 * order.
	 */
	toIncludeSamePartialMembers(members: ReadonlyArray<Partial<ArrayElement<T>>>): R;

	/**
	 * Use `.toPartiallyContain` when checking if any array value matches
	 * the partial member.
	 */
	toPartiallyContain(member: Partial<ArrayElement<T>>): R;

	/** Use `.toReject` when checking if a promise rejects. */
	toReject(): Promise<R>;

	/** Use `.toResolve` when checking if a promise resolves. */
	toResolve(): Promise<R>;

	/**
	 * Use `.toSatisfy` when you want to use a custom matcher by supplying a
	 * predicate function that returns a `Boolean`.
	 */
	toSatisfy(predicate: (value: Subject<T>) => boolean): R;

	/**
	 * Use `.toSatisfyAll` when you want to use a custom matcher by
	 * supplying a predicate function that returns a `Boolean` for all
	 * values in an array.
	 */
	toSatisfyAll(predicate: (value: ArrayElement<T>) => boolean): R;

	/**
	 * Use `.toSatisfyAny` when you want to use a custom matcher by
	 * supplying a predicate function that returns `true` for any matching
	 * value in an array.
	 */
	toSatisfyAny(predicate: (value: ArrayElement<T>) => boolean): R;

	/**
	 * Use `.toStartWith` when checking if a `String` starts with a given
	 * `String` prefix.
	 */
	toStartWith(prefix: string): R;

	/**
	 * Use `.toThrowWithMessage` when checking if a callback function
	 * throws an error of a given type with a given error message.
	 */
	toThrowWithMessage(
		type:
			| ((...args: Array<any>) => { message: string })
			| (new (...args: Array<any>) => { message: string }),
		message: RegExp | string,
	): R;
}

declare module "vitest" {
	interface Matchers<R, T> extends JestExtendedMatchers<R, T> {}
}

declare const matchers: Parameters<typeof import("vitest").expect.extend>[0];

export = matchers;
