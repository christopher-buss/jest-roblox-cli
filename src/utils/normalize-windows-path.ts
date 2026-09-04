import * as path from "node:path";

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

const UNC_SHARE_REGEX = /^\/\/[^/]+\/[^/]+/;
const DRIVE_ROOT_REGEX = /^[A-Za-z]:(?=\/)/;

/**
 * A directory in the one POSIX spelling {@link toPosixRoot} reduces it to.
 *
 * The tag is what separates a root that has been canonicalized from one
 * straight out of a config file, which are otherwise both `string`. A consumer
 * states the requirement in its signature, so a raw spelling passed where a
 * root belongs is a compile error rather than something a reviewer has to
 * catch.
 */
export type PosixRoot = PosixRootBrand & string;

/**
 * The tag and nothing else — never present at runtime; the compiler reads it
 * to tell a canonical root from any other string. Hand-rolled rather than
 * type-fest's `Tagged`: its `tagged.d.ts` pulls in a second module,
 * `tagged-tag`, which `deps.onlyBundle` does not name, and the declaration
 * build refuses to inline a `node_modules` module it was not told to.
 */
interface PosixRootBrand {
	readonly isPosixRoot: true;
}

interface NamespaceSplit {
	/** What lies under the frame, its leading separator included. */
	body: string;
	/** The frame itself, carrying no trailing separator. */
	stem: string;
}

export function normalizeWindowsPath(input = ""): string {
	return input
		.replace(/\\/g, "/")
		.replace(DRIVE_LETTER_START_REGEX, (driveLetterMatch) => driveLetterMatch.toUpperCase());
}

/**
 * Reduces a directory to the one POSIX spelling used as a path prefix, such as
 * a luau root or a tsconfig `outDir`.
 *
 * A caller either joins a relative name onto the root, or compares the root to
 * another root or a rojo `$path`. Both need every spelling of one directory to
 * arrive as the same string: `path.join` writes no leading `./`, no trailing
 * `/`, no `.` or `..` segment and no doubled separator, so a root carrying any
 * of them compares unequal to a path naming the same place, and two roots that
 * differ only in spelling both survive a dedupe. This is the package's only
 * answer to that, and a new consumer inherits it rather than growing its own.
 */
export function toPosixRoot(directoryPath: string): PosixRoot {
	const normalized = normalizeWindowsPath(directoryPath);
	const namespace = splitNamespace(normalized);
	if (namespace === undefined) {
		// `normalize` spells the current directory `.` and keeps a trailing
		// separator on everything else, which no join wants.
		return asPosixRoot(path.posix.normalize(normalized).replace(TRAILING_SLASH, ""));
	}

	// Normalized against a root of its own, so a parent segment stops at the
	// namespace instead of eating it. That is what the host owning the
	// spelling does, and it is what keeps an absolute root absolute.
	const body = path.posix.normalize(`/${namespace.body}`);
	// A namespace with nothing under it is all separator, and there the
	// separator is the whole name. Stripping it would leave `""`, `D:` or
	// `//server/share`, none of which `isAbsolutePath` or `path.join` read as
	// absolute, and a root that lies about being relative gets past the check
	// that refuses absolute ones.
	const tail = body === "/" ? body : body.replace(TRAILING_SLASH, "");
	return asPosixRoot(namespace.stem + tail);
}

/**
 * What {@link underRoot} puts in front of a name, and what
 * {@link relativeToRoot} takes off it. Hoistable: a caller naming many files
 * under one root pays the concatenation once.
 */
export function rootPrefix(root: PosixRoot): string {
	// The current directory names its children by themselves, and a
	// file-system root is the separator already. Every other root needs one.
	if (root === ".") {
		return "";
	}

	return root.endsWith("/") ? root : `${root}/`;
}

/**
 * Names a path under a root, in the one spelling every manifest key, coverage
 * universe check and shadow lookup compares. Written out at a call site,
 * `${root}/${relativePath}` names a file nothing else does whenever the root is
 * all prefix — the current directory, a file-system root, a drive or share
 * root.
 */
export function underRoot(root: PosixRoot, relativePath: string): string {
	return rootPrefix(root) + relativePath;
}

/**
 * The inverse of {@link underRoot}: what a key names relative to a root, or
 * `undefined` when it names something outside it. The `/` the prefix ends in
 * is what keeps `out-tsc/init.luau` from reading as a file under `out`.
 */
export function relativeToRoot(root: PosixRoot, key: string): string | undefined {
	const prefix = rootPrefix(root);
	if (prefix === "") {
		// The current directory has no prefix to test, and every string starts
		// with nothing. What it holds is every relative name and only those: an
		// absolute key names a file in a frame of its own.
		return isAbsolutePath(key) ? undefined : key;
	}

	return key.startsWith(prefix) ? key.slice(prefix.length) : undefined;
}

/**
 * The absolute frame a root names, split from the path under it, or
 * `undefined` when the root is relative.
 *
 * POSIX normalize knows no frame but `/`. It reads `D:` as an ordinary
 * segment, so `D:/../../out` climbs off the drive and comes back as the
 * relative `../out`, and it folds a UNC `//server/share` down to
 * `/server/share` — a directory on this host rather than the share.
 */
function splitNamespace(normalizedPath: string): NamespaceSplit | undefined {
	const share = UNC_SHARE_REGEX.exec(normalizedPath)?.[0];
	if (share !== undefined) {
		return { body: normalizedPath.slice(share.length), stem: share };
	}

	const drive = DRIVE_ROOT_REGEX.exec(normalizedPath)?.[0];
	if (drive !== undefined) {
		return { body: normalizedPath.slice(drive.length), stem: drive };
	}

	// The file-system root is its own separator, thus it is all body.
	return normalizedPath.startsWith("/") ? { body: normalizedPath, stem: "" } : undefined;
}

/**
 * The one place the brand is applied, so `toPosixRoot` is its only source. A
 * tag exists only in the type system, thus an assertion is how one is ever
 * attached.
 */
function asPosixRoot(canonical: string): PosixRoot {
	// eslint-disable-next-line ts/no-unsafe-type-assertion -- see above
	return canonical as PosixRoot;
}
