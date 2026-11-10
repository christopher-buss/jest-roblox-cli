import * as path from "node:path";

type RojoExec = (
	file: string,
	args: Array<string>,
	options: object,
	callback: (cause: Error | null, stdout: string, stderr: string) => void,
) => void;

export function writingRojoExec({
	bytes,
	fileSystem,
	onBuild,
}: {
	bytes: string;
	fileSystem: {
		mkdirSync(path: string, options: { recursive: true }): unknown;
		writeFileSync(path: string, bytes: string): unknown;
	};
	onBuild?: () => void;
}): RojoExec {
	return (...[, args, , callback]) => {
		onBuild?.();
		const outputPath = String(args[3]);
		fileSystem.mkdirSync(path.dirname(outputPath), { recursive: true });
		fileSystem.writeFileSync(outputPath, bytes);
		callback(null, "", "");
	};
}
