import type { RbxPath } from "./rbx-path.ts";

/** Looks up the file Rojo builds a DataModel path from. */
export interface ReverseMapper {
	/**
	 * Map more files; a file added later wins a DataModel path it shares.
	 * @param files - Paths of files the lookup can return from now on.
	 */
	add(files: Iterable<string>): void;
	/**
	 * Look up the file for a DataModel path.
	 * @param rbxPath - DataModel path in the shape `getRbxPath` returned.
	 * @returns The file path, or undefined when no given file maps to it.
	 */
	resolve(rbxPath: RbxPath): string | undefined;
}

/**
 * Inverts a file-to-DataModel mapper over a known set of files.
 * @param files - Paths of every file the lookup can return; `add` maps more.
 * @param getRbxPath - Forward mapper; a file it leaves unmapped is skipped.
 * @returns A ReverseMapper over `files`.
 */
export function createReverseMapper(
	files: Iterable<string>,
	getRbxPath: (filePath: string) => RbxPath | undefined,
): ReverseMapper {
	const map = new Map<string, string>();

	function add(added: Iterable<string>): void {
		for (const filePath of added) {
			const rbxPath = getRbxPath(filePath);
			if (rbxPath !== undefined) {
				map.set(serializeRbxPath(rbxPath), filePath);
			}
		}
	}

	add(files);

	return {
		add,
		resolve(rbxPath) {
			return map.get(serializeRbxPath(rbxPath));
		},
	};
}

function serializeRbxPath(rbxPath: RbxPath): string {
	return rbxPath.join("\0");
}
