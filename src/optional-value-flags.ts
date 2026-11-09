import type { ParallelOption } from "./backends/interface.ts";
import { UNCOMMITTED_REF } from "./related/changed-files.ts";

/** The flag of a Partial Run over git changes. */
export const CHANGED_FLAG = "--changed";

const PARALLEL_FLAG = "--parallel";
const VM_PARALLEL_FLAG = "--experimental-vm-parallel";
const INTEGER_LIKE_PATTERN = /^-?\d+$/;

const BARE_FLAG_VALUE = "auto";

/**
 * The flags whose value is optional: `--parallel` and
 * `--experimental-vm-parallel` both mean "pick the count for me" when written
 * bare, and a bare `--changed` means the uncommitted changes against `HEAD`.
 * `parseArgs` has no optional-value mode, so the bare form is rewritten to
 * the flag's `bareValue` before it gets there.
 *
 * `isValueLike` decides what counts as this flag's value rather than the next
 * argument: anything else (a following flag, a positional test path) leaves
 * the flag bare. `--changed` takes any next argument that is not a flag as its
 * ref, as vitest does.
 */
const OPTIONAL_VALUE_FLAGS: ReadonlyArray<{
	bareValue: string;
	isValueLike: (next: string) => boolean;
	name: string;
}> = [
	{
		name: PARALLEL_FLAG,
		bareValue: BARE_FLAG_VALUE,
		isValueLike: (next) => next === "auto" || INTEGER_LIKE_PATTERN.test(next),
	},
	{
		name: VM_PARALLEL_FLAG,
		bareValue: BARE_FLAG_VALUE,
		isValueLike: (next) => next === BARE_FLAG_VALUE || INTEGER_LIKE_PATTERN.test(next),
	},
	{ name: CHANGED_FLAG, bareValue: UNCOMMITTED_REF, isValueLike: () => true },
];

/**
 * Rewrite each bare optional-value flag to the flag and its `bareValue`, so
 * `parseArgs` sees a value for it.
 *
 * @param args - Arguments after the executable and script path.
 * @returns The arguments with every optional value written out.
 */
export function normalizeOptionalValueFlags(args: Array<string>): Array<string> {
	const out: Array<string> = [];
	for (let index = 0; index < args.length; index++) {
		// oxlint-disable-next-line typescript/no-non-null-assertion -- index bounded by args.length
		const current = args[index]!;
		const flag = OPTIONAL_VALUE_FLAGS.find((entry) => entry.name === current);
		if (flag === undefined) {
			out.push(current);
			continue;
		}

		const next = args[index + 1];
		if (next !== undefined && !next.startsWith("-") && flag.isValueLike(next)) {
			out.push(flag.name, next);
			index += 1;
		} else {
			out.push(flag.name, flag.bareValue);
		}
	}

	return out;
}

/**
 * `--parallel [n]`: how many Open Cloud sessions run at once.
 *
 * @param raw - The flag value, or `undefined` when the flag is absent.
 * @returns `undefined` when absent, `"auto"` when bare, else the count.
 * @throws {Error} When the value is not a positive integer or `auto`.
 */
export function parseParallelValue(raw: string | undefined): ParallelOption {
	if (raw === undefined) {
		return undefined;
	}

	if (raw === "auto") {
		return "auto";
	}

	if (!INTEGER_LIKE_PATTERN.test(raw)) {
		throw new Error(`Invalid --parallel value "${raw}". Must be a positive integer or "auto".`);
	}

	const parsed = Number(raw);
	if (parsed < 1) {
		throw new Error(`Invalid --parallel value "${raw}". Must be a positive integer or "auto".`);
	}

	return parsed;
}

/**
 * `--experimental-vm-parallel [n]`: how many Luau VMs the Studio plugin splits
 * the run's configs across. Bare — or the `auto` the bare form is rewritten to,
 * which a user may also type — means one VM per config; an explicit count must
 * be a positive integer, and the plugin clamps it to the configs it was given
 * and the hosts it ships.
 *
 * @param raw - The flag value, or `undefined` when the flag is absent.
 * @returns `undefined` when absent, `"auto"` when bare, else the count.
 * @throws {Error} When the value is not a positive integer.
 */
export function parseVmParallelValue(raw: string | undefined): ParallelOption {
	if (raw === undefined) {
		return undefined;
	}

	if (raw === BARE_FLAG_VALUE) {
		return "auto";
	}

	const parsed = Number.parseInt(raw, 10);
	if (Number.isNaN(parsed) || parsed < 1) {
		throw new Error(`Invalid ${VM_PARALLEL_FLAG} value "${raw}". Must be a positive integer.`);
	}

	return parsed;
}
