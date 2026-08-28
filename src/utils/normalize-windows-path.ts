const DRIVE_LETTER_START_REGEX = /^[A-Za-z]:\//;
const DRIVE_LETTER_PREFIX = /^[A-Za-z]:/;

/**
 * Drop a leading drive letter, leaving a drive-agnostic absolute path.
 *
 * Use when comparing two paths that may disagree about the letter: Node's
 * `path.resolve` stamps the cwd's drive onto a drive-less absolute path, so a
 * resolved file and the root it came from can differ by nothing else. One
 * process cannot span two drives, which makes the letter carry no information
 * worth comparing.
 */
export function dropDriveLetter(input: string): string {
	return input.replace(DRIVE_LETTER_PREFIX, "");
}

/**
 * Whether a normalized path is absolute on *any* host — a posix root (`/repo`)
 * or a drive-letter root (`D:/repo`).
 *
 * Node's `path.isAbsolute` answers for the host it runs on, so a Windows path
 * reads as relative on Linux and CI diverges from a local run. This asks the
 * platform-independent question instead. Feed it `normalizeWindowsPath` output;
 * a backslash path is not recognized.
 */
export function isAbsolutePath(input: string): boolean {
	return input.startsWith("/") || DRIVE_LETTER_START_REGEX.test(input);
}

const TRAILING_SLASH = /\/$/;

export function normalizeWindowsPath(input = ""): string {
	return input
		.replace(/\\/g, "/")
		.replace(DRIVE_LETTER_START_REGEX, (driveLetterMatch) => driveLetterMatch.toUpperCase());
}

/**
 * The POSIX form of a directory used as a path prefix — a luau root, an
 * `outDir` — with the trailing separator dropped.
 *
 * Every walk in the coverage pipeline slices its results against the root it
 * was handed, so a root written `out/` would otherwise leave each slice one
 * character short and mangle every relative path in the tree. Producers and
 * consumers of those paths have to normalize the same way, which is why this
 * is one function rather than a `replace` at each site.
 */
export function toPosixRoot(directoryPath: string): string {
	return normalizeWindowsPath(directoryPath).replace(TRAILING_SLASH, "");
}
