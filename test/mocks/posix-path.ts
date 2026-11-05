import { fromAny } from "@total-typescript/shoehorn";

import * as path from "node:path";

import type { PosixRoot } from "../../src/utils/normalize-windows-path.ts";

const DRIVE_LETTER_START = /^[A-Za-z]:\//;
const TRAILING_SLASH = /(?<=.)\/$/;

export function posixPath(input: string): string {
	return input
		.replaceAll("\\", "/")
		.replace(DRIVE_LETTER_START, (driveLetter) => driveLetter.toUpperCase());
}

export function posixRoot(directoryPath: string): PosixRoot {
	const normalized = path.posix.normalize(posixPath(directoryPath)).replace(TRAILING_SLASH, "");
	return fromAny<PosixRoot, string>(normalized);
}
