import * as path from "node:path";

import type { FileSystem } from "#src/utils/file-system.ts";
import { sha256 } from "#test/mocks/coverage-hash.ts";

export function rojoInputsHash(
	fileSystem: FileSystem,
	{
		mountedFiles = [],
		rojoProjectPath,
		rootDirectory,
	}: { mountedFiles?: ReadonlyArray<string>; rojoProjectPath: string; rootDirectory: string },
): string {
	const lines = [rojoProjectPath, ...mountedFiles].map((file) => {
		const relative = path.relative(rootDirectory, file).replaceAll("\\", "/");
		return `${relative}\0${sha256(fileSystem.readFileSync(file))}`;
	});
	return sha256(lines.toSorted().join("\n"));
}
