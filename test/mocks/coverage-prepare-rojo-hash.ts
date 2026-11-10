import * as path from "node:path";

import type { FileSystem } from "#src/utils/file-system.ts";
import { hashBuffer, hashString } from "#test/mocks/coverage-hash.ts";

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
		return `${relative}\0${hashBuffer(fileSystem.readFileSync(file))}`;
	});
	return hashString(lines.toSorted().join("\n"));
}
