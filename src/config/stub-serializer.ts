import {
	toRobloxTestMatch,
	toRobloxTestPathIgnorePatterns,
} from "../typecheck/type-test-pattern.ts";
import { isString } from "../utils/is-string.ts";
import type { ProjectTestConfig, UndefinedTolerant } from "./schema.ts";
import { DEFAULT_CONFIG } from "./schema.ts";
import { HEADER } from "./stub-files.ts";

const SKIP_FIELDS: ReadonlySet<string> = new Set(["exclude", "include"]);

/** Project test config fields written into a generated Luau stub. */
export type StubConfig = Partial<UndefinedTolerant<ProjectTestConfig>>;

/**
 * Serialize a stub config to Luau.
 *
 * @param config - Stub fields to serialize; `include`, `exclude` and undefined values are skipped.
 * @returns Luau source of a stub that returns the config table.
 */
export function serializeToLuau(config: StubConfig): string {
	let output = `${HEADER}return {\n`;

	const robloxConfig = {
		...config,
		testPathIgnorePatterns: toRobloxTestPathIgnorePatterns(
			config.testPathIgnorePatterns ?? DEFAULT_CONFIG.testPathIgnorePatterns,
		),
	};
	for (const [key, value] of Object.entries(robloxConfig)) {
		if (SKIP_FIELDS.has(key)) {
			continue;
		}

		if (value === undefined) {
			continue;
		}

		const serialized = serializeLuauValue(
			key === "testMatch" && Array.isArray(value)
				? toRobloxTestMatch(value.filter(isString))
				: value,
		);

		output += `\t${key} = ${serialized},\n`;
	}

	output += "}\n";
	return output;
}

function escapeString(value: string): string {
	return value
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/\n/g, "\\n")
		.replace(/\r/g, "\\r")
		.replace(/\t/g, "\\t");
}

function serializeLuauValue(value: unknown): string {
	if (typeof value === "string") {
		return `"${escapeString(value)}"`;
	}

	if (Array.isArray(value)) {
		const items = value.map((item: unknown) => serializeLuauValue(item));
		return `{ ${items.join(", ")} }`;
	}

	if (typeof value === "object" && value !== null) {
		const entries = Object.entries(value)
			.filter(([, propertyValue]) => propertyValue !== undefined)
			.map(([key, propertyValue]) => `${key} = ${serializeLuauValue(propertyValue)}`);
		return `{ ${entries.join(", ")} }`;
	}

	return String(value);
}
