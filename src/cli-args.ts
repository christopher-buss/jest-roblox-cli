import type { ParseArgsOptionDescriptor } from "node:util";
import { parseArgs as nodeParseArgs } from "node:util";

import { BARE_FLAG_VALUE } from "./config/option-parsers.ts";
import type { AnyCliFlag } from "./config/option-row.ts";
import { OPTION_ROWS } from "./config/options.ts";
import type { CliOptions } from "./config/resolved-config.ts";

interface FlaggedRow {
	readonly key: string;
	readonly cli: AnyCliFlag;
}

const FLAGGED_ROWS: ReadonlyArray<FlaggedRow> = OPTION_ROWS.flatMap(({ key, cli }) => {
	return cli === undefined ? [] : [{ key, cli }];
});

const PARSE_OPTIONS: Record<string, ParseArgsOptionDescriptor> = Object.fromEntries(
	FLAGGED_ROWS.flatMap(({ cli }) => {
		const descriptor: ParseArgsOptionDescriptor = {
			type: cli.value === undefined ? "boolean" : "string",
		};
		if (cli.multiple === true) {
			descriptor.multiple = true;
		}

		if (cli.short !== undefined) {
			descriptor.short = cli.short;
		}

		const negation: Array<[string, ParseArgsOptionDescriptor]> =
			cli.negation === undefined ? [] : [[cli.negation.name, { type: "boolean" }]];
		return [[cli.name, descriptor], ...negation];
	}),
);

/**
 * Parse the CLI argument list into options.
 * @param args - Arguments after the executable and script path.
 * @returns The parsed CLI options.
 */
export function parseArgs(args: Array<string>): CliOptions {
	const { positionals, values } = nodeParseArgs({
		allowPositionals: true,
		args: normalizeOptionalValueFlags(args),
		options: PARSE_OPTIONS,
		strict: true,
	});

	const options: CliOptions = {};
	for (const { key, cli } of FLAGGED_ROWS) {
		Reflect.set(options, key, readFlag(cli, values));
	}

	if (options.typecheckOnly === true) {
		options.typecheck = true;
	}

	applySelectionOptions(options, positionals);

	return options;
}

function readFlag(
	cli: AnyCliFlag,
	values: Record<string, Array<boolean | string> | boolean | string | undefined>,
): unknown {
	if (cli.negation !== undefined && values[cli.negation.name] === true) {
		return false;
	}

	const raw = values[cli.name];
	if (Array.isArray(raw)) {
		const list = raw.map(String);
		return cli.parseList === undefined ? list : cli.parseList(list);
	}

	return typeof raw === "string" && cli.parse !== undefined ? cli.parse(raw) : raw;
}

function normalizeOptionalValueFlags(args: Array<string>): Array<string> {
	const out: Array<string> = [];
	for (let index = 0; index < args.length; index++) {
		// oxlint-disable-next-line typescript/no-non-null-assertion -- index bounded by args.length
		const current = args[index]!;
		const flag = FLAGGED_ROWS.find(({ cli }) => `--${cli.name}` === current)?.cli;
		if (flag?.bare === undefined) {
			out.push(current);
			continue;
		}

		const next = args[index + 1];
		if (next !== undefined && !next.startsWith("-") && flag.bare(next)) {
			out.push(current, next);
			index += 1;
		} else {
			out.push(current, flag.bareValue ?? BARE_FLAG_VALUE);
		}
	}

	return out;
}

function applySelectionOptions(options: CliOptions, positionals: Array<string>): void {
	const [command, ...related] = positionals;
	if (command === "related") {
		if (related.length === 0) {
			throw new Error("related needs at least one source file.");
		}

		if (options.changed !== undefined) {
			throw new Error("related and --changed cannot be used together.");
		}

		options.related = related;
	} else {
		options.files = positionals.length > 0 ? positionals : undefined;
	}

	if (options.changed?.startsWith("-") === true) {
		throw new Error(`Invalid --changed ref "${options.changed}".`);
	}

	if (options.related !== undefined || options.changed !== undefined) {
		options.passWithNoTests ??= true;
	}
}
