import { fromAny } from "@total-typescript/shoehorn";

import * as path from "node:path";

import type { PosixRoot } from "#src/utils/normalize-windows-path.ts";
import { posixPath } from "#test/helpers/posix-path.ts";

const TRAILING_SLASH = /(?<=.)\/$/;

export function posixRoot(directoryPath: string): PosixRoot {
	const normalized = path.posix.normalize(posixPath(directoryPath)).replace(TRAILING_SLASH, "");
	return fromAny<PosixRoot, string>(normalized);
}
