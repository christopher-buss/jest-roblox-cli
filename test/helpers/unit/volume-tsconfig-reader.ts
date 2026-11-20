import { fromAny } from "@total-typescript/shoehorn";

import * as path from "node:path";

import type { TsconfigReader } from "#src/tsconfig/tsconfig-mappings.ts";
import type { FileSystem } from "#src/utils/file-system.ts";

/**
 * A tsconfig reader over a spec's own volume, in place of `get-tsconfig`,
 * which reads the real disk.
 * @param fileSystem - Volume to read from.
 * @returns A reader that returns null when the file is missing.
 */
export function readingVolume(fileSystem: FileSystem): TsconfigReader {
	return fromAny((searchPath: string, configName = "tsconfig.json") => {
		const filePath = path.join(path.resolve(searchPath), configName);
		if (!fileSystem.existsSync(filePath)) {
			return null;
		}

		return { config: JSON.parse(fileSystem.readFileSync(filePath, "utf-8")), path: filePath };
	});
}
