export interface LuteExecFileOptions {
	readonly value?: string;
	readonly version?: string;
	readonly versionError?: Error;
}

type Callback = (error: Error | null, stdout: string, stderr: string) => void;

export function luteExecFile({
	value = "{}",
	version = "1.0.1",
	versionError,
}: LuteExecFileOptions) {
	return (_file: string, args: Array<string>, _options: unknown, callback: Callback): object => {
		const isVersion = args[0] === "--version";
		callback(
			isVersion ? (versionError ?? null) : null,
			isVersion ? version : `\n<<jest-roblox:luau-config-value>>${value}\n`,
			"",
		);
		return {};
	};
}
