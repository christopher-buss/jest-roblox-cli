import * as path from "node:path";

import type { ShadowBake } from "#src/coverage-pipeline/spine.ts";
import type { FileSystem } from "#src/utils/file-system.ts";

const STUB = "jest.config.luau";
const STUB_TEXT = "-- generated stub\nreturn {}\n";

export function stubBake(fileSystem: FileSystem, mountPaths: ReadonlyArray<string>): ShadowBake {
	return {
		isBakeOwned: (shadowPath) => path.basename(shadowPath) === STUB,
		run: (shadow) => {
			let hasChanged = false;
			for (const mountPath of mountPaths) {
				if (!shadow.isShadowed(mountPath)) {
					continue;
				}

				const target = path.resolve(shadow.mountedDirectory(mountPath), STUB);
				if (
					fileSystem.existsSync(target) &&
					fileSystem.readFileSync(target, "utf-8") === STUB_TEXT
				) {
					continue;
				}

				fileSystem.mkdirSync(path.dirname(target), { recursive: true });
				fileSystem.writeFileSync(target, STUB_TEXT);
				hasChanged = true;
			}

			return hasChanged;
		},
		stubMounts: () => [],
	};
}
