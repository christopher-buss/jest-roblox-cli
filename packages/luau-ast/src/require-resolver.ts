import path from "node:path";

import type { LuauParser } from "./parser.ts";
import type { RequireFileSystem } from "./require-aliases.ts";
import { createAliasLookup, toPosix } from "./require-aliases.ts";

/** The file a string require loads, or why it loads none. */
export type StringRequireResolution =
	| { kind: "resolved"; path: string }
	| { kind: "unresolved"; reason: string };

/** Resolves one `require("...")` string from the file that holds it. */
export type StringRequireResolver = (
	fromFilePath: string,
	requireString: string,
) => StringRequireResolution;

interface WalkState {
	currentDirectory: string;
	inLeadingDotZone: boolean;
}

type Start = { kind: "start"; state: WalkState } | { kind: "unresolved"; reason: string };

const LUAU_EXTENSIONS = [".luau", ".lua"] as const;
const INIT_BASENAMES: ReadonlySet<string> = new Set(["init.lua", "init.luau"]);

interface StartInput {
	firstPart: string;
	fromFilePath: string;
	lookupAlias: ReturnType<typeof createAliasLookup>;
}

interface AliasStartInput extends StartInput {
	callerDirectory: string;
}

/**
 * Build a resolver for Luau's require-by-string rules on the file system.
 * `./` and `../` resolve from the requiring file's folder; an `init` file
 * stands for its folder, so they resolve from that folder's parent. `@self`
 * resolves inside an `init` file's folder. Any other `@alias` resolves through
 * `.config.luau`, then `.luaurc`, from the requiring file's folder up. A
 * path names a `.luau` or `.lua` file, or a folder with an `init` file.
 * Probes and configuration reads are cached for the resolver's lifetime.
 *
 * @param options - The file system, and the parser that reads `.config.luau`.
 * @returns A function from the requiring file and its require string to the
 *   file it loads.
 */
export function createStringRequireResolver(options: {
	fileSystem: RequireFileSystem;
	parser: LuauParser;
}): StringRequireResolver {
	const lookupAlias = createAliasLookup(options);
	const probeCache = new Map<string, ReadonlyArray<string>>();
	return (fromFilePath, requireString) => {
		const slash = requireString.indexOf("/");
		const firstPart = slash === -1 ? requireString : requireString.slice(0, slash);
		const start = startOf({ firstPart, fromFilePath, lookupAlias });
		if (start.kind === "unresolved") {
			return start;
		}

		const parts = requireString.split("/");
		const walked = walkParts(start.state, firstPart.startsWith("@") ? parts.slice(1) : parts);
		if (walked.kind === "unresolved") {
			return walked;
		}

		const target = walked.state.currentDirectory;
		const probe = probeModule({ cache: probeCache, fileSystem: options.fileSystem, target });
		const failure = `cannot resolve require("${requireString}") from ${fromFilePath}`;
		const [resolved, ...others] = probe;
		if (resolved === undefined) {
			return {
				kind: "unresolved",
				reason: `${failure}: no module at ${target} (tried .luau, .lua, /init.luau, /init.lua)`,
			};
		}

		return others.length > 0
			? { kind: "unresolved", reason: `${failure}: ambiguous between ${probe.join(" and ")}` }
			: { kind: "resolved", path: resolved };
	};
}

function isInitModule(filePath: string): boolean {
	return INIT_BASENAMES.has(path.basename(filePath));
}

function aliasStart(input: AliasStartInput): Start {
	const { callerDirectory, firstPart, fromFilePath } = input;
	if (firstPart === "@self") {
		return isInitModule(fromFilePath)
			? {
					kind: "start",
					state: { currentDirectory: callerDirectory, inLeadingDotZone: false },
				}
			: {
					kind: "unresolved",
					reason: `@self requires are only valid from init.luau / init.lua (from ${fromFilePath})`,
				};
	}

	const alias = input.lookupAlias({ name: firstPart.slice(1), directory: callerDirectory });
	if (alias.kind === "found") {
		return { kind: "start", state: { currentDirectory: alias.path, inLeadingDotZone: false } };
	}

	return {
		kind: "unresolved",
		reason:
			alias.kind === "invalid"
				? alias.reason
				: `${firstPart} is not an alias in any .config.luau or .luaurc (from ${fromFilePath})`,
	};
}

function startOf(input: StartInput): Start {
	const { firstPart, fromFilePath } = input;
	const callerDirectory = toPosix(path.dirname(fromFilePath));
	if (firstPart === "." || firstPart === "..") {
		const currentDirectory = isInitModule(fromFilePath)
			? toPosix(path.dirname(callerDirectory))
			: callerDirectory;
		return { kind: "start", state: { currentDirectory, inLeadingDotZone: true } };
	}

	if (firstPart.startsWith("@")) {
		return aliasStart({ ...input, callerDirectory });
	}

	return {
		kind: "unresolved",
		reason:
			firstPart === ""
				? `paths beginning with '/' are not supported (from ${fromFilePath})`
				: `bare require("${firstPart}") is not supported; use a relative path (from ${fromFilePath})`,
	};
}

function walkParts(
	state: WalkState,
	parts: ReadonlyArray<string>,
): { kind: "unresolved"; reason: string } | { kind: "walked"; state: WalkState } {
	for (const part of parts) {
		if (part === "") {
			continue;
		}

		if (part === "." || part === ".." || part === "@self") {
			if (!state.inLeadingDotZone) {
				return {
					kind: "unresolved",
					reason: `'${part}' is only allowed at the beginning of a require path`,
				};
			}

			if (part === "..") {
				state.currentDirectory = toPosix(path.dirname(state.currentDirectory));
			} else {
				state.inLeadingDotZone = false;
			}

			continue;
		}

		state.currentDirectory = toPosix(path.join(state.currentDirectory, part));
		state.inLeadingDotZone = false;
	}

	return { kind: "walked", state };
}

function probeModule({
	cache,
	fileSystem,
	target,
}: {
	cache: Map<string, ReadonlyArray<string>>;
	fileSystem: RequireFileSystem;
	target: string;
}): ReadonlyArray<string> {
	const cached = cache.get(target);
	if (cached !== undefined) {
		return cached;
	}

	const candidates = [
		...LUAU_EXTENSIONS.map((extension) => target + extension),
		...LUAU_EXTENSIONS.map((extension) => `${target}/init${extension}`),
	];
	const matches = candidates.filter((candidate) => fileSystem.existsSync(candidate));
	cache.set(target, matches);
	return matches;
}
