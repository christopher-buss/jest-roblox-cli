/* eslint-disable unicorn/no-keyword-prefix -- `className` is the Code Bundle's own key, which the Luau rebuild reads by name. */
import {
	CLIENT_SUB_EXTENSION,
	convertToLuau,
	INIT_NAME,
	JSON_EXT,
	resolveMountPath,
	ROJO_SCRIPT_EXTS,
	SERVER_SUB_EXTENSION,
	stripRojoExtensions,
} from "@isentinel/rojo-utils";

import * as path from "node:path";

import { isWithinRoot } from "../coverage-pipeline/redirect-path.ts";
import type { Dirent, FileSystem } from "../utils/file-system.ts";
import { isString } from "../utils/is-string.ts";
import type { PosixRoot } from "../utils/normalize-windows-path.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import type {
	BundleInstance,
	BundleInstanceClass,
	CodeBundleEntry,
	MountContents,
} from "./code-split-types.ts";

/** Where and how a mount's `$path` is read. */
export interface MountScan {
	/** Roots a mount must sit within to travel. */
	codeRoots: ReadonlyArray<PosixRoot>;
	/** Reads the mounted files and directories. */
	fileSystem: FileSystem;
	/** The paths the project drops, which rojo builds nothing from. */
	ignored: (absolutePath: string) => boolean;
	/** Directory a relative `$path` resolves against. */
	projectDirectory: string;
}

/**
 * The `.json` files rojo reads as something other than a module: instance
 * descriptors and nested projects. Each describes an Instance built from
 * elsewhere, so a mount holding one cannot travel as scripts alone.
 */
const DESCRIPTOR_JSON = /\.(?:meta|model|project)\.json$/;
/**
 * The extensions rojo builds an instance from that no task can construct:
 * rojo's own set less the scripts and plain `.json` modules
 * {@link readScriptFile} claims above.
 *
 * Rojo's `snapshot_from_fs_path` returns `None` for every extension outside
 * that set and builds nothing from it, so a file this one does not name is
 * neutral — a `.d.ts` and a `.luau.map` sit beside every script a stock
 * roblox-ts `out/` holds, and a rule that read them as blockers left every
 * real consumer with nothing to travel.
 */
const BLOCKING_EXTENSIONS: ReadonlySet<string> = new Set([
	".csv",
	".json",
	".rbxm",
	".rbxmx",
	".toml",
	".txt",
]);
/** The sub-extension a script file carries, and the class rojo gives it. */
const SUB_EXTENSION_CLASSES = new Map<string, BundleInstanceClass>([
	[CLIENT_SUB_EXTENSION, "LocalScript"],
	[SERVER_SUB_EXTENSION, "Script"],
]);

/**
 * Orders by depth and by nothing else, leaning on a stable sort to keep the
 * walk's own order within a level. Two orderings would be two rules to keep in
 * step with the rebuild; this one is the rebuild's only requirement.
 * @template T
 * @param items - Items to sort in place.
 * @param depth - Depth of one item.
 */
export function sortShallowestFirst<T>(items: Array<T>, depth: (item: T) => number): void {
	items.sort((left, right) => depth(left) - depth(right));
}

/**
 * The Code Mount a node's `$path` declares, `"stays"` when it holds something
 * that has to stay, or `undefined` when it declares none that can travel. A
 * mount outside every Code Root, one the project already drops, and one that
 * is not on disk are all silent: rojo treats them as it always did, and none
 * of them is a speedup a consumer could go and claim.
 * @param rawPath - The node's `$path` value.
 * @param scan - Code Roots, file system, ignore matcher and project directory.
 * @returns The mount's contents, `"stays"`, or `undefined`.
 */
export function readCodeMount(
	rawPath: unknown,
	scan: MountScan,
): "stays" | MountContents | undefined {
	if (!isString(rawPath)) {
		return undefined;
	}

	const fsPath = normalizeWindowsPath(resolveMountPath(scan.projectDirectory, rawPath));
	if (scan.codeRoots.every((root) => !isWithinRoot(fsPath, root)) || scan.ignored(fsPath)) {
		return undefined;
	}

	const stats = scan.fileSystem.statSync(fsPath, { throwIfNoEntry: false });
	if (stats === undefined) {
		return undefined;
	}

	const isDirectory = stats.isDirectory();
	const contents = isDirectory ? readDirectoryMount(fsPath, scan) : readFileMount(fsPath, scan);
	// A directory that held something back is a speedup left on the table. A
	// file mount is one only when rojo built an instance from the file; when
	// it did not there was never anything there to serve, so the mount is as
	// silent as one outside every Code Root.
	if (contents === undefined && (isDirectory || holdsMountBack(fsPath))) {
		return "stays";
	}

	return contents;
}

/**
 * Whether a file {@link readScriptFile} turned down is one rojo would still
 * have built, which is the only kind that holds its mount back.
 * @param fileName - File name or path.
 * @returns True when the extension is one rojo builds and no task can.
 */
function holdsMountBack(fileName: string): boolean {
	return BLOCKING_EXTENSIONS.has(path.extname(fileName));
}

/**
 * How many instances deep a slash-joined path sits.
 * @param instancePath - Slash-joined instance path.
 * @returns Number of path segments.
 */
function depthOf(instancePath: string): number {
	return instancePath.split("/").length;
}

/**
 * What a directory mount contributes, or `undefined` when it holds something
 * that has to stay. Entries come back shallowest first so an `init`-promoted
 * directory exists before anything nested under it — created the other way
 * round, the descendant leaves a plain Folder where a ModuleScript belongs.
 * @param directory - Absolute directory the mount points at.
 * @param scan - File system and ignore matcher for the walk.
 * @returns The mount's root and entries, or `undefined` when it stays.
 */
function readDirectoryMount(directory: string, scan: MountScan): MountContents | undefined {
	const entries: Array<CodeBundleEntry> = [];
	const root = collectDirectoryInto({ directory, entries, prefix: "", scan });
	if (root === undefined) {
		return undefined;
	}

	sortShallowestFirst(entries, (entry) => depthOf(entry.path));
	return { entries, root };
}

/**
 * The class rojo gives a `.luau`/`.lua` file, from its sub-extension.
 * @param fileName - Script file name.
 * @returns `LocalScript`, `Script`, or `ModuleScript`.
 */
function classifyLuauFile(fileName: string): BundleInstanceClass {
	const luau = convertToLuau(fileName);
	const stem = luau.slice(0, -path.extname(luau).length);
	return SUB_EXTENSION_CLASSES.get(path.extname(stem)) ?? "ModuleScript";
}

/**
 * Whether rojo would build a script from the file, read through rojo's own
 * script set — `convertToLuau` is what folds `.lua` into it.
 * @param fileName - File name to test.
 * @returns True for a script file.
 */
function isLuauFile(fileName: string): boolean {
	return ROJO_SCRIPT_EXTS.has(path.extname(convertToLuau(fileName)));
}

/**
 * The instance rojo builds from one file, and the name it gives it, or
 * `undefined` for a file no task can construct.
 *
 * A `.json` module is a ModuleScript returning the decoded value. The source
 * decodes it at require time rather than re-encoding the value as Luau here:
 * the text is already the value, and a re-encoder would be a second JSON
 * implementation to keep true.
 * @param options - The file and how to read it.
 * @param options.directory - Directory holding the file.
 * @param options.fileName - File name within the directory.
 * @param options.fileSystem - Reads the file source.
 * @returns The instance and its name, or `undefined`.
 */
function readScriptFile({
	directory,
	fileName,
	fileSystem,
}: {
	directory: string;
	fileName: string;
	fileSystem: FileSystem;
}): undefined | { instance: BundleInstance; name: string } {
	const filePath = path.posix.join(directory, fileName);
	if (isLuauFile(fileName)) {
		return {
			name: stripRojoExtensions(convertToLuau(fileName)),
			instance: {
				className: classifyLuauFile(fileName),
				source: fileSystem.readFileSync(filePath, "utf-8"),
			},
		};
	}

	if (path.extname(fileName) !== JSON_EXT || DESCRIPTOR_JSON.test(fileName)) {
		return undefined;
	}

	const json = fileSystem.readFileSync(filePath, "utf-8");
	return {
		name: stripRojoExtensions(fileName),
		instance: {
			className: "ModuleScript",
			source: `return game:GetService("HttpService"):JSONDecode([==[${json}]==])`,
		},
	};
}

/**
 * What a file mount contributes: the one script it is. Its name comes from the
 * tree key rather than the file, so only the class and the source travel — the
 * `jest.config` stub the synthesizer injects is one of these.
 * @param filePath - Absolute path of the mounted file.
 * @param scan - Supplies the file system.
 * @returns The script as the mount root, or `undefined` when no task can build it.
 */
function readFileMount(filePath: string, scan: MountScan): MountContents | undefined {
	const script = readScriptFile({
		directory: path.posix.dirname(filePath),
		fileName: path.posix.basename(filePath),
		fileSystem: scan.fileSystem,
	});
	return script === undefined ? undefined : { entries: [], root: script.instance };
}

/**
 * Whether the file is the one that gives its directory a class of its own.
 * @param fileName - File name to test.
 * @returns True for an `init` script.
 */
function isInitFile(fileName: string): boolean {
	return isLuauFile(fileName) && stripRojoExtensions(convertToLuau(fileName)) === INIT_NAME;
}

/**
 * The entries of one directory rojo would read, in the one order a bundle is
 * written in.
 *
 * Sorted rather than left in readdir order, which is the host's: an
 * alphabetical bundle is the same bytes from the same tree on every machine,
 * and a spec can name what it expects. Sorted through the names rather than by
 * a comparator over the entries, because the default sort is codepoint order
 * over strings already and a hand-written comparator would only be a second
 * spelling of it — one whose equal case a directory can never reach.
 * @param directory - Directory to read.
 * @param scan - File system and ignore matcher.
 * @returns The entries not ignored, sorted by name.
 */
function readVisibleEntries(directory: string, scan: MountScan): Array<Dirent> {
	const children = scan.fileSystem
		.readdirSync(directory, { withFileTypes: true })
		.filter((child) => !scan.ignored(path.posix.join(directory, child.name)));
	const byName = new Map(children.map((child) => [child.name, child]));
	return [...byName.keys()].sort().map((name) => {
		// oxlint-disable-next-line typescript/no-non-null-assertion -- every key came out of this map
		return byName.get(name)!;
	});
}

/**
 * What the directory instance itself is, which its own `init` file decides.
 * @param options - The directory and its `init` file.
 * @param options.directory - Directory the instance stands for.
 * @param options.fileSystem - Reads the `init` source.
 * @param options.initFile - The directory's `init` file, if any.
 * @returns A Folder, or the script class and source of the `init` file.
 */
function readPromotedRoot({
	directory,
	fileSystem,
	initFile,
}: {
	directory: string;
	fileSystem: FileSystem;
	initFile: Dirent | undefined;
}): BundleInstance {
	if (initFile === undefined) {
		return { className: "Folder" };
	}

	return {
		className: classifyLuauFile(initFile.name),
		source: fileSystem.readFileSync(path.posix.join(directory, initFile.name), "utf-8"),
	};
}

function joinInstancePath(prefix: string, name: string): string {
	return prefix === "" ? name : `${prefix}/${name}`;
}

/**
 * Walk one directory, appending what it holds, and report the instance the
 * directory itself becomes — or `undefined` the moment it holds a file no task
 * can construct, which holds the whole mount back.
 * @param options - The directory and where its entries go.
 * @param options.directory - Directory to walk.
 * @param options.entries - Receives each entry found; mutated.
 * @param options.prefix - Instance path of the directory, empty at the mount root.
 * @param options.scan - File system and ignore matcher.
 * @returns The directory's instance, or `undefined` when the mount stays.
 */
function collectDirectoryInto({
	directory,
	entries,
	prefix,
	scan,
}: {
	directory: string;
	entries: Array<CodeBundleEntry>;
	prefix: string;
	scan: MountScan;
}): BundleInstance | undefined {
	const children = readVisibleEntries(directory, scan);
	const initFile = children.find((child) => !child.isDirectory() && isInitFile(child.name));
	const root = readPromotedRoot({ directory, fileSystem: scan.fileSystem, initFile });
	if (prefix !== "") {
		entries.push({ ...root, path: prefix });
	}

	for (const child of children) {
		// The promoting file is the directory rather than a child beside it,
		// so it is read once above and skipped here.
		if (child !== initFile && !collectChild({ child, directory, entries, prefix, scan })) {
			return undefined;
		}
	}

	return root;
}

/**
 * Whether one directory entry could travel; `false` holds the mount back.
 * @param options - The entry and where its instances go.
 * @param options.child - Directory entry to collect.
 * @param options.directory - Directory holding the entry.
 * @param options.entries - Receives each entry found; mutated.
 * @param options.prefix - Instance path of the holding directory.
 * @param options.scan - File system and ignore matcher.
 * @returns False when the entry holds the mount back.
 */
function collectChild({
	child,
	directory,
	entries,
	prefix,
	scan,
}: {
	child: Dirent;
	directory: string;
	entries: Array<CodeBundleEntry>;
	prefix: string;
	scan: MountScan;
}): boolean {
	if (child.isDirectory()) {
		const nested = collectDirectoryInto({
			directory: path.posix.join(directory, child.name),
			entries,
			prefix: joinInstancePath(prefix, child.name),
			scan,
		});
		return nested !== undefined;
	}

	const script = readScriptFile({
		directory,
		fileName: child.name,
		fileSystem: scan.fileSystem,
	});
	if (script === undefined) {
		// A file rojo builds nothing from contributes nothing to the place, so
		// there is nothing to rebuild and nothing to leave behind: it rides
		// along with its mount without reaching the bundle.
		return !holdsMountBack(child.name);
	}

	entries.push({ ...script.instance, path: joinInstancePath(prefix, script.name) });
	return true;
}
