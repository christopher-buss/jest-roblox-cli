import { fromAny } from "@total-typescript/shoehorn";

import type { ChildProcessRunner } from "#src/utils/child-process.ts";

type Callback = (error: Error | null, stdout: string, stderr: string) => void;

export function createLuteChildProcess({
	value = "{}",
	version = "1.0.1",
	versionError,
}: {
	readonly value?: string;
	readonly version?: string;
	readonly versionError?: Error;
}): ChildProcessRunner {
	return fromAny({
		execFile: (_file: string, args: Array<string>, _options: unknown, callback: Callback) => {
			const isVersion = args[0] === "--version";
			callback(
				isVersion ? (versionError ?? null) : null,
				isVersion ? version : `\n<<jest-roblox:luau-config-value>>${value}\n`,
				"",
			);
			return {};
		},
	});
}
