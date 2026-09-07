/* eslint-disable unicorn/no-keyword-prefix -- `className` is the Code Bundle's own key, which the Luau rebuild reads by name. */
import {
	CLIENT_SUB_EXTENSION,
	convertToLuau,
	INIT_NAME,
	isRojoTreeNode,
	JSON_EXT,
	resolveMountPath,
	ROJO_SCRIPT_EXTS,
	SERVER_SUB_EXTENSION,
	stripRojoExtensions,
} from "@isentinel/rojo-utils";

import type { Dirent } from "node:fs";
import * as path from "node:path";

import { isWithinRoot } from "../coverage-pipeline/redirect-path.ts";
import type { RojoTreeNode } from "../types/rojo.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";
import { isString } from "../utils/is-string.ts";
import type { PosixRoot } from "../utils/normalize-windows-path.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import { createIgnoreMatcher, readGlobIgnorePaths } from "./glob-ignore.ts";

export interface SplitCodeMountsOptions {
	/**
	 * The Code Roots: directories holding the code this run compiled. A mount
	 * that resolves inside one is a candidate to travel; every other mount
	 * stays, because a task can rebuild a script and nothing else.
	 */
	codeRoots: ReadonlyArray<PosixRoot>;
	/** Where the mounts are read. Defaults to the real filesystem. */
	fileSystem?: FileSystem;
	/** The directory the synthesized project file is written to. */
	projectDirectory: string;
	projectJson: string;
}

export interface CodeSplit {
	/** The Code Bundle as the task reads it, ready to write. */
	bundleJson: string;
	/** How many source files the bundle carries, for its stage line. */
	fileCount: number;
	/** The Harness Place's project: this one, less what travels. */
	harnessProjectJson: string;
	/**
	 * DataModel paths of the Code Mounts that had to stay, slash-joined for
	 * reading, in the order the project declares them. A finding rather than an
	 * error — the place still serves them, and this is the only thing that says
	 * which speedup was left on the table.
	 */
	stayedMounts: Array<string>;
}

/**
 * What {@link splitCodeMounts} would emit, as a number the place-reuse key can
 * hold. Bump it whenever this module would produce a different Harness Place
 * from unchanged sources — a different candidate rule, a different naming
 * rule, a different pruning rule.
 *
 * The key covers this pass's inputs and not the pass, so without a bump a
 * harness built by the old rule reads as current and is handed out unchanged.
 */
export const CODE_SPLIT_PASS_VERSION = 1;

/** The Code Bundle shape a task rebuilds. Bump on any change to it. */
const CODE_BUNDLE_FORMAT_VERSION = 1;

/** Every class the rebuild can construct, and so every class that travels. */
type BundleInstanceClass = "Folder" | "LocalScript" | "ModuleScript" | "Script";

interface BundleInstance {
	className: BundleInstanceClass;
	/** Absent for a Folder, which carries no source. */
	source?: string;
}

interface CodeBundleEntry extends BundleInstance {
	/** Slash-joined under the mount root, e.g. `example/test.spec`. */
	path: string;
}

interface CodeBundleMount {
	/**
	 * One segment per instance down from the DataModel, the first a service
	 * name. Segments rather than a joined string because an instance name may
	 * hold the separator: a workspace stage node is named after its package,
	 * and a scoped one is `@scope/pkg`.
	 */
	dataModelPath: Array<string>;
	entries: Array<CodeBundleEntry>;
	/**
	 * Rebuild over what the harness holds there rather than in place of it.
	 * Set for a mount the project declares children beside: those children
	 * stayed, so replacing the instance whole would take them with it.
	 */
	merge: boolean;
	root: BundleInstance;
}

/** One mount's contents, before the tree says whether it merges. */
type MountContents = Pick<CodeBundleMount, "entries" | "root">;

/** What the tree walk threads through every level. */
interface Split {
	codeRoots: ReadonlyArray<PosixRoot>;
	fileSystem: FileSystem;
	/** Whether the walk rewrote the tree, so the harness is not the input. */
	hasRewritten: boolean;
	/** The paths the project drops, which rojo builds nothing from. */
	ignored: (absolutePath: string) => boolean;
	mounts: Array<CodeBundleMount>;
	projectDirectory: string;
	stayedMounts: Array<string>;
}

/**
 * One level of the walk: the node, where in the DataModel it sits, and the
 * split every level contributes to.
 *
 * `depth` counts from the tree root, so 1 is a service — named for rojo rather
 * than for the instance under it, which is why an empty one stays.
 */
interface WalkFrame {
	dataModelPath: ReadonlyArray<string>;
	depth: number;
	node: RojoTreeNode;
	split: Split;
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
 * Split a synthesized rojo project into the Harness Place that stays and the
 * Code Bundle that travels.
 *
 * A mount whose `$path` resolves inside a Code Root and exists on disk is a
 * Code Mount candidate. It travels only when every instance rojo would build
 * from it is a script a task can construct — `.luau`, `.lua`, and
 * non-descriptor `.json` — because an `.rbxm`, a `.meta.json` or a `.toml` has
 * no runtime constructor and a mount that left one behind would go missing
 * from the run. A file rojo builds no instance from rides along instead: it
 * neither travels nor holds the mount back, which is what lets a stock
 * roblox-ts `out/` travel with its `.d.ts` and `.luau.map` files in place.
 * Rojo's own naming rules decide each instance: `init` promotes its directory,
 * `.server`/`.client` pick the script class, every other stem is kept whole so
 * `test.spec.luau` stays `test.spec`.
 *
 * A mount that travels with no explicit children leaves the tree, and an
 * ancestor left with nothing goes with it — except a service, which the
 * project names for rojo rather than for the instance under it. One the
 * project declares children beside keeps its node as a Folder holding them,
 * and the bundle marks it `merge` so the rebuild does not take them out.
 *
 * Pure over the project text and the filesystem: nothing is written here, so
 * the caller decides whether the bundle it gets back is worth writing.
 *
 * A change to what this emits from unchanged sources needs
 * {@link CODE_SPLIT_PASS_VERSION} bumped with it; the place-reuse key reads
 * this pass through that number and through nothing else.
 */
export function splitCodeMounts({
	codeRoots,
	fileSystem = nodeFileSystem,
	projectDirectory,
	projectJson,
}: SplitCodeMountsOptions): CodeSplit {
	const parsed = readProjectTree(projectJson);
	if (parsed === undefined) {
		return splitNothing(projectJson);
	}

	const { project, tree } = parsed;

	const split: Split = {
		codeRoots,
		fileSystem,
		hasRewritten: false,
		ignored: createIgnoreMatcher(readGlobIgnorePaths(project)),
		mounts: [],
		projectDirectory,
		stayedMounts: [],
	};
	visitChildren({ dataModelPath: [], depth: 0, node: tree, split });

	// Shallowest first, which is the one ordering the rebuild needs: a nested
	// mount has to land after the mount it sits under, or the outer one
	// replaces it whole on the way past.
	sortShallowestFirst(split.mounts, (mount) => mount.dataModelPath.length);
	return {
		bundleJson: serializeBundle(split.mounts),
		fileCount: countSources(split.mounts),
		harnessProjectJson: split.hasRewritten
			? JSON.stringify(project, undefined, 2)
			: projectJson,
		stayedMounts: split.stayedMounts,
	};
}

function serializeBundle(mounts: Array<CodeBundleMount>): string {
	return JSON.stringify({ mounts, version: CODE_BUNDLE_FORMAT_VERSION });
}

/**
 * The project and the tree it declares, or `undefined` for a project text this
 * pass cannot walk.
 */
function readProjectTree(
	projectJson: string,
): undefined | { project: RojoTreeNode; tree: RojoTreeNode } {
	const project = JSON.parse(projectJson);
	if (!isRojoTreeNode(project)) {
		return undefined;
	}

	const { tree } = project;
	return isRojoTreeNode(tree) ? { project, tree } : undefined;
}

/**
 * The split of a project this pass reads nothing out of — a malformed one, or
 * a tree it cannot walk. The harness is the project itself, which is what
 * every other staging pass hands back rather than failing the build.
 */
function splitNothing(projectJson: string): CodeSplit {
	return {
		bundleJson: serializeBundle([]),
		fileCount: 0,
		harnessProjectJson: projectJson,
		stayedMounts: [],
	};
}

/**
 * Orders by depth and by nothing else, leaning on a stable sort to keep the
 * walk's own order within a level. Two orderings would be two rules to keep in
 * step with the rebuild; this one is the rebuild's only requirement.
 */
function sortShallowestFirst<T>(items: Array<T>, depth: (item: T) => number): void {
	items.sort((left, right) => depth(left) - depth(right));
}

/** Whether the instance carries a file's text rather than being a Folder. */
function hasSource({ source }: BundleInstance): boolean {
	return source !== undefined;
}

/** How many files the bundle carries — every instance but the Folders. */
function countSources(mounts: Array<CodeBundleMount>): number {
	let count = 0;
	for (const mount of mounts) {
		if (hasSource(mount.root)) {
			count += 1;
		}

		for (const entry of mount.entries) {
			if (hasSource(entry)) {
				count += 1;
			}
		}
	}

	return count;
}

/** How many instances deep a slash-joined path sits. */
function depthOf(instancePath: string): number {
	return instancePath.split("/").length;
}

/** The class rojo gives a `.luau`/`.lua` file, from its sub-extension. */
function classifyLuauFile(fileName: string): BundleInstanceClass {
	const luau = convertToLuau(fileName);
	const stem = luau.slice(0, -path.extname(luau).length);
	return SUB_EXTENSION_CLASSES.get(path.extname(stem)) ?? "ModuleScript";
}

/**
 * Whether a file {@link readScriptFile} turned down is one rojo would still
 * have built, which is the only kind that holds its mount back.
 */
function holdsMountBack(fileName: string): boolean {
	return BLOCKING_EXTENSIONS.has(path.extname(fileName));
}

/**
 * Whether rojo would build a script from the file, read through rojo's own
 * script set — `convertToLuau` is what folds `.lua` into it.
 */
function isLuauFile(fileName: string): boolean {
	return ROJO_SCRIPT_EXTS.has(path.extname(convertToLuau(fileName)));
}

/** Whether the file is the one that gives its directory a class of its own. */
function isInitFile(fileName: string): boolean {
	return isLuauFile(fileName) && stripRojoExtensions(convertToLuau(fileName)) === INIT_NAME;
}

/**
 * The instance rojo builds from one file, and the name it gives it, or
 * `undefined` for a file no task can construct.
 *
 * A `.json` module is a ModuleScript returning the decoded value. The source
 * decodes it at require time rather than re-encoding the value as Luau here:
 * the text is already the value, and a re-encoder would be a second JSON
 * implementation to keep true.
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
 * The entries of one directory rojo would read, in the one order a bundle is
 * written in.
 *
 * Sorted rather than left in readdir order, which is the host's: an
 * alphabetical bundle is the same bytes from the same tree on every machine,
 * and a spec can name what it expects. Sorted through the names rather than by
 * a comparator over the entries, because the default sort is codepoint order
 * over strings already and a hand-written comparator would only be a second
 * spelling of it — one whose equal case a directory can never reach.
 */
function readVisibleEntries(directory: string, split: Split): Array<Dirent> {
	const children = split.fileSystem
		.readdirSync(directory, { withFileTypes: true })
		.filter((child) => !split.ignored(path.posix.join(directory, child.name)));
	const byName = new Map(children.map((child) => [child.name, child]));
	return [...byName.keys()].sort().map((name) => {
		// eslint-disable-next-line ts/no-non-null-assertion -- every key came out of this map
		return byName.get(name)!;
	});
}

/** What the directory instance itself is, which its own `init` file decides. */
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
 */
function collectDirectoryInto({
	directory,
	entries,
	prefix,
	split,
}: {
	directory: string;
	entries: Array<CodeBundleEntry>;
	prefix: string;
	split: Split;
}): BundleInstance | undefined {
	const children = readVisibleEntries(directory, split);
	const initFile = children.find((child) => !child.isDirectory() && isInitFile(child.name));
	const root = readPromotedRoot({ directory, fileSystem: split.fileSystem, initFile });
	if (prefix !== "") {
		entries.push({ ...root, path: prefix });
	}

	for (const child of children) {
		// The promoting file is the directory rather than a child beside it,
		// so it is read once above and skipped here.
		if (child !== initFile && !collectChild({ child, directory, entries, prefix, split })) {
			return undefined;
		}
	}

	return root;
}

/** Whether one directory entry could travel; `false` holds the mount back. */
function collectChild({
	child,
	directory,
	entries,
	prefix,
	split,
}: {
	child: Dirent;
	directory: string;
	entries: Array<CodeBundleEntry>;
	prefix: string;
	split: Split;
}): boolean {
	if (child.isDirectory()) {
		const nested = collectDirectoryInto({
			directory: path.posix.join(directory, child.name),
			entries,
			prefix: joinInstancePath(prefix, child.name),
			split,
		});
		return nested !== undefined;
	}

	const script = readScriptFile({
		directory,
		fileName: child.name,
		fileSystem: split.fileSystem,
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

/**
 * What a directory mount contributes, or `undefined` when it holds something
 * that has to stay. Entries come back shallowest first so an `init`-promoted
 * directory exists before anything nested under it — created the other way
 * round, the descendant leaves a plain Folder where a ModuleScript belongs.
 */
function readDirectoryMount(directory: string, split: Split): MountContents | undefined {
	const entries: Array<CodeBundleEntry> = [];
	const root = collectDirectoryInto({ directory, entries, prefix: "", split });
	if (root === undefined) {
		return undefined;
	}

	sortShallowestFirst(entries, (entry) => depthOf(entry.path));
	return { entries, root };
}

/**
 * What a file mount contributes: the one script it is. Its name comes from the
 * tree key rather than the file, so only the class and the source travel — the
 * `jest.config` stub the synthesizer injects is one of these.
 */
function readFileMount(filePath: string, split: Split): MountContents | undefined {
	const script = readScriptFile({
		directory: path.posix.dirname(filePath),
		fileName: path.posix.basename(filePath),
		fileSystem: split.fileSystem,
	});
	return script === undefined ? undefined : { entries: [], root: script.instance };
}

/**
 * The Code Mount a node declares, or `undefined` when it declares none that
 * can travel. A mount outside every Code Root, one the project already drops,
 * and one that is not on disk are all silent: rojo treats them as it always
 * did, and none of them is a speedup a consumer could go and claim.
 */
function readCodeMount({ dataModelPath, node, split }: WalkFrame): MountContents | undefined {
	const rawPath = node.$path;
	if (!isString(rawPath)) {
		return undefined;
	}

	const fsPath = normalizeWindowsPath(resolveMountPath(split.projectDirectory, rawPath));
	if (split.codeRoots.every((root) => !isWithinRoot(fsPath, root)) || split.ignored(fsPath)) {
		return undefined;
	}

	const stats = split.fileSystem.statSync(fsPath, { throwIfNoEntry: false });
	if (stats === undefined) {
		return undefined;
	}

	const isDirectory = stats.isDirectory();
	const contents = isDirectory ? readDirectoryMount(fsPath, split) : readFileMount(fsPath, split);
	// A directory that held something back is a speedup left on the table. A
	// file mount is one only when rojo built an instance from the file; when
	// it did not there was never anything there to serve, so the mount is as
	// silent as one outside every Code Root.
	if (contents === undefined && (isDirectory || holdsMountBack(fsPath))) {
		// Joined here and nowhere else: this one is read by a person off
		// stderr, not walked by the rebuild.
		split.stayedMounts.push(dataModelPath.join("/"));
	}

	return contents;
}

/** Whether the project declares instances of its own beneath this node. */
function hasChildNodes(node: RojoTreeNode): boolean {
	return Object.entries(node).some(([key, value]) => {
		return !key.startsWith("$") && isRojoTreeNode(value);
	});
}

/**
 * Whether the node describes nothing once its children are gone: no mount, no
 * class of its own, and nothing under it. Rojo would build an empty Folder for
 * it, which is a folder the run never had.
 */
function isEmptyNode(node: RojoTreeNode): boolean {
	return node.$path === undefined && node.$className === undefined && !hasChildNodes(node);
}

/** Whether the node leaves the harness tree along with what it mounted. */
function visitNode(frame: WalkFrame): boolean {
	const { dataModelPath, depth, node, split } = frame;
	const contents = readCodeMount(frame);
	// Children first, so `merge` and the emptiness test below both read the
	// tree as the harness will hold it rather than as the project wrote it: a
	// child that left is not one the harness has to keep serving.
	visitChildren(frame);
	if (contents === undefined) {
		// A service is named for rojo rather than for the instance under it,
		// and rojo builds it whether or not the project puts anything there.
		return depth > 1 && isEmptyNode(node);
	}

	const isMerging = hasChildNodes(node);
	split.mounts.push({ ...contents, dataModelPath: [...dataModelPath], merge: isMerging });
	split.hasRewritten = true;
	if (!isMerging) {
		return true;
	}

	delete node.$path;
	node.$className = "Folder";
	return false;
}

function visitChildren({ dataModelPath, depth, node, split }: WalkFrame): void {
	for (const [key, value] of Object.entries(node)) {
		if (key.startsWith("$") || !isRojoTreeNode(value)) {
			continue;
		}

		const child: WalkFrame = {
			dataModelPath: [...dataModelPath, key],
			depth: depth + 1,
			node: value,
			split,
		};
		if (visitNode(child)) {
			// oxlint-disable-next-line no-dynamic-delete -- the key is a tree node's own instance name
			delete node[key];
			split.hasRewritten = true;
		}
	}
}
