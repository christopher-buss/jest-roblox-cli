import { Buffer } from "node:buffer";
import * as cp from "node:child_process";

export function buildWithRojo(projectPath: string, outputPath: string): void {
	try {
		cp.execFileSync("rojo", ["build", projectPath, "-o", outputPath], {
			stdio: "pipe",
		});
	} catch (err) {
		if (err instanceof Error && "code" in err && err.code === "ENOENT") {
			throw new Error("rojo is required for --coverage but was not found on PATH");
		}

		const stderr =
			err instanceof Error && "stderr" in err && Buffer.isBuffer(err.stderr)
				? err.stderr.toString().trim()
				: undefined;

		const message =
			stderr !== undefined && stderr.length > 0
				? `rojo build failed: ${stderr}`
				: "rojo build failed";
		throw new Error(message, { cause: err });
	}
}
