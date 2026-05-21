export interface ChainEntry {
	readonly name: string;
	readonly code?: string;
	readonly errno?: string;
	readonly message: string;
	readonly syscall?: string;
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
			syscall: readStringProperty(current, "syscall"),
		});
		current = current.cause;
	}

	return entries;
}

function readStringProperty(err: Error, key: string): string | undefined {
	const value = Reflect.get(err, key);

	if (value === undefined || value === null) {
		return undefined;
	}

	return String(value);
}
