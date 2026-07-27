import { PermissionError } from "@bedrock-rbx/ocale";

export interface ChainEntry {
	readonly name: string;
	readonly code?: string | undefined;
	readonly errno?: string | undefined;
	readonly message: string;
	readonly requiredScopes?: ReadonlyArray<string> | undefined;
	readonly syscall?: string | undefined;
}

const MAX_DEPTH = 5;

export function walkErrorChain(err: unknown): Array<ChainEntry> {
	const entries: Array<ChainEntry> = [];
	let current: unknown = err;
	while (current instanceof Error && entries.length < MAX_DEPTH) {
		entries.push({
			name: current.constructor.name,
			code: readStringProperty(current, "code"),
			errno: readStringProperty(current, "errno"),
			message: current.message,
			requiredScopes: current instanceof PermissionError ? current.requiredScopes : undefined,
			syscall: readStringProperty(current, "syscall"),
		});
		current = current.cause;
	}

	return entries;
}

export function formatMissingScopes(scopes: ReadonlyArray<string>): string {
	if (scopes.length === 0) {
		return "API key has insufficient scopes. Add via Creator Dashboard.";
	}

	const joined = scopes.join(", ");
	return `API key missing scope${scopes.length === 1 ? "" : "s"} ${joined}. Add via Creator Dashboard.`;
}

function readStringProperty(err: Error, key: string): string | undefined {
	const value: unknown = Reflect.get(err, key);

	if (typeof value === "string") {
		return value;
	}

	// Node errors carry `errno` as a number; anything else (object, boolean) has
	// no useful string form, so it reads as absent.
	if (typeof value === "number") {
		return String(value);
	}

	return undefined;
}
