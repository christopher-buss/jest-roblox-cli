import * as path from "node:path";

const DRIVE_LETTER_START_REGEX = /^[A-Za-z]:\//;
const DRIVE_LETTER_PREFIX = /^[A-Za-z]:/;

/**
 * Drop a leading drive letter, leaving a drive-agnostic absolute path.
 * @param input - A normalized path.
 * @returns The path without a leading drive letter.
 */
export function dropDriveLetter(input: string): string {
	return input.replace(DRIVE_LETTER_PREFIX, "");
}

/**
 * Whether a normalized path is absolute on any host.
 * @param input - A normalized path.
 * @returns True for a `/` or drive-letter root.
 */
export function isAbsolutePath(input: string): boolean {
	return input.startsWith("/") || DRIVE_LETTER_START_REGEX.test(input);
}

/**
 * Whether a path is a directory or lies below it. Both paths are absolute.
 * Uses `isAbsolutePath`, not `path.isAbsolute`, because a Windows path reads as
 * relative on Linux, which would let CI accept what a local run rejects.
 * @param directory - Absolute directory.
 * @param candidate - Absolute path to test.
 * @returns Whether `candidate` is `directory` or below it.
 */
export function isPathInside(directory: string, candidate: string): boolean {
	const relative = normalizeWindowsPath(path.relative(directory, candidate));
	return !relative.startsWith("..") && !isAbsolutePath(relative);
}

/**
 * Resolve a path against a directory, keeping an absolute one as it is.
 * @param directory - Directory a relative path resolves in.
 * @param filePath - Path to resolve.
 * @returns The absolute `/`-separated path.
 */
export function resolveFromDirectory(directory: string, filePath: string): string {
	const normalized = normalizeWindowsPath(filePath);
	return isAbsolutePath(normalized)
		? normalized
		: normalizeWindowsPath(path.resolve(directory, normalized));
}

const TRAILING_SLASH = /\/$/;

const UNC_SHARE_REGEX = /^\/\/[^/]+\/[^/]+/;
const DRIVE_ROOT_REGEX = /^[A-Za-z]:(?=\/)/;

/** A directory in the one POSIX spelling `toPosixRoot` reduces it to. */
export type PosixRoot = PosixRootBrand & string;

// Not type-fest `Tagged`: its `tagged-tag` import is absent from
// `deps.onlyBundle`, so the declaration build fails.
interface PosixRootBrand {
	readonly isPosixRoot: true;
}

interface NamespaceSplit {
	body: string;
	stem: string;
}

/**
 * Turn backslashes into `/` and upper-case a leading drive letter.
 * @param input - The path to normalize; defaults to an empty string.
 * @returns The `/`-separated path.
 */
export function normalizeWindowsPath(input = ""): string {
	return input
		.replace(/\\/g, "/")
		.replace(DRIVE_LETTER_START_REGEX, (driveLetterMatch) => driveLetterMatch.toUpperCase());
}

/**
 * Reduce a directory to the one POSIX spelling used as a path prefix.
 * @param directoryPath - The directory as written.
 * @returns Its canonical root.
 */
export function toPosixRoot(directoryPath: string): PosixRoot {
	const normalized = normalizeWindowsPath(directoryPath);
	const namespace = splitNamespace(normalized);
	if (namespace === undefined) {
		return asPosixRoot(path.posix.normalize(normalized).replace(TRAILING_SLASH, ""));
	}

	// The leading `/` stops a parent segment from climbing out of the namespace.
	const body = path.posix.normalize(`/${namespace.body}`);
	// A bare namespace keeps its `/`, or `isAbsolutePath` reads it as relative.
	const tail = body === "/" ? body : body.replace(TRAILING_SLASH, "");
	return asPosixRoot(namespace.stem + tail);
}

/**
 * What `underRoot` puts in front of a name.
 * @param root - A canonical root.
 * @returns The root with one trailing `/`, or `""` for `.`.
 */
export function rootPrefix(root: PosixRoot): string {
	if (root === ".") {
		return "";
	}

	return root.endsWith("/") ? root : `${root}/`;
}

/**
 * Name a path under a root, in the one spelling every lookup compares.
 * @param root - A canonical root.
 * @param relativePath - The name under it.
 * @returns The path joined onto the root.
 */
export function underRoot(root: PosixRoot, relativePath: string): string {
	return rootPrefix(root) + relativePath;
}

/**
 * The inverse of `underRoot`.
 * @param root - A canonical root.
 * @param key - A path that may lie under the root.
 * @returns The path relative to the root, or `undefined`.
 */
export function relativeToRoot(root: PosixRoot, key: string): string | undefined {
	const prefix = rootPrefix(root);
	if (prefix === "") {
		return isAbsolutePath(key) ? undefined : key;
	}

	return key.startsWith(prefix) ? key.slice(prefix.length) : undefined;
}

/**
 * True when `target` is `root` itself or sits inside it.
 * @param target - Candidate contained path.
 * @param root - Candidate containing directory.
 * @returns Whether `target` is within `root`.
 */
export function isWithinRoot(target: string, root: string): boolean {
	return target === root || target.startsWith(`${root}/`);
}

function splitNamespace(normalizedPath: string): NamespaceSplit | undefined {
	const share = UNC_SHARE_REGEX.exec(normalizedPath)?.[0];
	if (share !== undefined) {
		return { body: normalizedPath.slice(share.length), stem: share };
	}

	const drive = DRIVE_ROOT_REGEX.exec(normalizedPath)?.[0];
	if (drive !== undefined) {
		return { body: normalizedPath.slice(drive.length), stem: drive };
	}

	return normalizedPath.startsWith("/") ? { body: normalizedPath, stem: "" } : undefined;
}

/**
 * The one place the brand is applied, so `toPosixRoot` is its only source.
 *
 * @param canonical - A path already in canonical form.
 * @returns The same path, branded.
 */
function asPosixRoot(canonical: string): PosixRoot {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
	return canonical as PosixRoot;
}
