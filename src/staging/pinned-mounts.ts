import { Buffer } from "node:buffer";
import * as fs from "node:fs";
import * as path from "node:path";
import picomatch from "picomatch";

import { ConfigError } from "../config/errors.ts";
import type { RojoTreeNode } from "../types/rojo.ts";
import { hashBuffer } from "../utils/hash.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import { buildWithRojo } from "../utils/rojo-builder.ts";
import { isRojoTreeNode } from "../utils/rojo-tree-node.ts";
import {
	isModelFile,
	META_JSON_FILE,
	MODEL_EXTENSIONS,
	readDeclaredClasses,
} from "./model-classes.ts";
import { PINNED_PARENT_CLASSES } from "./pinned-parent-classes.ts";

export interface DemotePinnedMountsOptions {
	/** The directory the synthesized project file is written to. */
	projectDirectory: string;
	projectJson: string;
	/** Where the rewritten stand-in models are written. */
	shadowDirectory: string;
}

/** A model a staged `$path` would mount with a class the engine pins. */
interface PinnedMount {
	/**
	 * Name rojo would give the mounted instance, or `undefined` when the
	 * mount's own `$path` is the offender and the node already names it.
	 */
	childName: string | undefined;
	/** Absolute path to the offending file or directory. */
	source: string;
	/** The tree node whose `$path` reaches it. */
	target: RojoTreeNode;
}

/**
 * What the tree walk threads through every level: where to collect offenders,
 * which paths the project already drops, and which have been scanned already.
 * A node may carry both a `$path` and explicit children mounting paths inside
 * it, so without `scanned` one source is reached twice — and rebuilt twice,
 * with two rojo builds racing on one stand-in file.
 */
interface Walk {
	ignored: (absolutePath: string) => boolean;
	pinned: Array<PinnedMount>;
	scanned: Set<string>;
}

const STAGE_KEY = "__pkg_stage";
const PINNED_XML_CLASS = /(<Item\s+class=")([^"]+)(")/g;
/**
 * An item's own properties — the block between its opening tag and its first
 * child `Item`, which is what the non-greedy match stops at. Keyed on the class
 * still written in the file, so it has to run BEFORE the class fold: once every
 * pinned class reads `Folder`, nothing tells a rewritten item apart from a
 * Folder the consumer authored, and stripping would reach both.
 */
const CLASSED_PROPERTIES =
	/(<Item\s+class="([^"]+)"[^>]*>\s*<Properties>)([\s\S]*?)(<\/Properties>)/g;
/** One serialized property: `<bool name="Anchored">true</bool>`. */
const XML_PROPERTY = /<(\w+) name="([^"]+)"[^>]*>[\s\S]*?<\/\1>/g;
/**
 * Properties `Instance` itself declares, so a Folder standing in for a service
 * still holds them. Everything else belonged to the class that was rewritten
 * away — `Terrain.Decoration`, `Workspace.Gravity` — and rojo would carry it
 * into the place as a property no Folder has.
 */
const INSTANCE_PROPERTIES = new Set(["AttributesSerialize", "Name", "Tags"]);
const DRIVE_LETTER = /^[A-Za-z]:/;

/**
 * Replace every staged mount that would bring a parent-pinned class into the
 * place with a Folder-rooted stand-in.
 *
 * `synthesize` demotes the classes a rojo project *declares*, which is all it
 * can see — a class inside an `.rbxm`, an `.rbxmx`, or a `*.model.json` only
 * appears once rojo reads the file. Rojo offers no override either:
 * `$className` beside a `$path` that is not a directory is a hard build error.
 * So the file is rebuilt through rojo as XML, its pinned classes are rewritten
 * to `Folder`, and the mount is pointed at the result. The original is added
 * to `globIgnorePaths` so the directory auto-mount that would otherwise re-add
 * it alongside the stand-in skips it.
 *
 * A no-wrap project has no stage and keeps every service where the engine
 * wants it, so this is a no-op for one.
 */
export function demotePinnedMounts({
	projectDirectory,
	projectJson,
	shadowDirectory,
}: DemotePinnedMountsOptions): string {
	const project = JSON.parse(projectJson);
	if (!isRojoTreeNode(project)) {
		return projectJson;
	}

	const stage = findStage(project);
	if (stage === undefined) {
		return projectJson;
	}

	const declaredIgnores = readGlobIgnorePaths(project);
	const pinned: Array<PinnedMount> = [];
	collectPinnedMounts(stage, {
		ignored: isIgnored(declaredIgnores),
		pinned,
		scanned: new Set(),
	});
	if (pinned.length === 0) {
		return projectJson;
	}

	fs.mkdirSync(shadowDirectory, { recursive: true });
	const ignores = new Set(declaredIgnores);
	const options = { declaredIgnores, projectDirectory, shadowDirectory };
	for (const mount of pinned) {
		for (const replaced of standInFor(mount, options)) {
			ignores.add(replaced);
		}
	}

	// Written through Reflect: a rojo tree node holds instance children, and the
	// static shape has no slot for the project-level list this appends to.
	Reflect.set(project, "globIgnorePaths", [...ignores]);
	return JSON.stringify(project, undefined, 2);
}

/** The name rojo gives a mounted entry: its basename, less the extension. */
function mountedName(entryName: string): string {
	const lower = entryName.toLowerCase();
	const extension = MODEL_EXTENSIONS.find((candidate) => lower.endsWith(candidate));
	return extension === undefined ? entryName : entryName.slice(0, -extension.length);
}

/** Enough of a hash of the source path to keep two stand-in names apart. */
function sourceDigest(source: string): string {
	return hashBuffer(Buffer.from(normalizeWindowsPath(source), "utf-8")).slice(0, 8);
}

/**
 * Rewrite every pinned class in a built model to `Folder` and drop the
 * properties that went with it.
 *
 * Properties first, classes second, and the order is load-bearing: the strip
 * has to know which items it is stripping, and after the fold every one of them
 * reads `Folder` — indistinguishable from a Folder the consumer authored, whose
 * properties are its own and must survive. Leaving a rewritten item's
 * properties instead would hand rojo a `Folder` carrying `Gravity` or
 * `Decoration`, which rojo writes into the place as an unknown property rather
 * than rejecting.
 */
function foldPinnedClasses(xml: string): string {
	const stripped = xml.replaceAll(
		CLASSED_PROPERTIES,
		(match: string, ...groups: Array<number | string>) => {
			const [open, declared, body, close] = groups;
			if (!PINNED_PARENT_CLASSES.has(String(declared))) {
				return match;
			}

			const kept = [...String(body).matchAll(XML_PROPERTY)]
				.filter((property) => INSTANCE_PROPERTIES.has(String(property[2])))
				.map((property) => `\n      ${property[0]}`)
				.join("");
			return `${open}${kept}\n    ${close}`;
		},
	);

	return stripped.replaceAll(
		PINNED_XML_CLASS,
		(match: string, ...groups: Array<number | string>) => {
			const [open, declared, close] = groups;
			return PINNED_PARENT_CLASSES.has(String(declared))
				? `${String(open)}Folder${String(close)}`
				: match;
		},
	);
}

/**
 * Rebuild one offending mount as XML through rojo, rewrite the pinned classes
 * to `Folder`, and return the path written.
 *
 * Rojo does the reading, so the stand-in carries whatever rojo would have put
 * in the place — scripts, nested models, JSON modules — and only the class of
 * the instances the engine would reject changes. The materializer clones the
 * stand-in's children into the live service by name and never reads its class,
 * so a Folder in that position costs the package nothing.
 */
function writeFolderShadow({
	globIgnorePaths,
	mount,
	shadowDirectory,
}: {
	globIgnorePaths: Array<string>;
	mount: PinnedMount;
	shadowDirectory: string;
}): string {
	const name = mount.childName ?? mountedName(path.basename(mount.source));
	// Named for the instance, disambiguated by a digest of the source path: two
	// mounts can build a `StarterPlayerScripts`, and the digest keeps the name
	// stable across runs so an unchanged tree rebuilds byte-identical bytes and
	// the place-reuse key still matches.
	const directory = normalizeWindowsPath(shadowDirectory);
	const stem = `${name}-${sourceDigest(mount.source)}`;
	const projectFile = path.posix.join(directory, `${stem}.project.json`);
	const shadowFile = path.posix.join(directory, `${stem}.rbxmx`);

	fs.writeFileSync(
		projectFile,
		JSON.stringify({
			// Rojo names the built root after the project, and the stand-in has
			// to answer to the same name the original mount did.
			name,
			globIgnorePaths,
			tree: { $path: normalizeWindowsPath(mount.source) },
		}),
	);
	buildWithRojo(projectFile, shadowFile);

	fs.writeFileSync(shadowFile, foldPinnedClasses(fs.readFileSync(shadowFile, "utf-8")));
	return shadowFile;
}

/**
 * Build one mount's stand-in and point the tree at it, reporting the paths the
 * project now has to ignore — none when the node already names the instance,
 * and the replaced original when the stand-in joins a directory auto-mount that
 * would otherwise re-add it alongside.
 */
function standInFor(
	mount: PinnedMount,
	{
		declaredIgnores,
		projectDirectory,
		shadowDirectory,
	}: {
		declaredIgnores: Array<string>;
		projectDirectory: string;
		shadowDirectory: string;
	},
): Array<string> {
	// Only the consumer's own patterns reach the child build: a generated entry
	// names a path relative to `projectDirectory`, which resolves against
	// nothing in a project that lives in `shadowDirectory`.
	const shadow = writeFolderShadow({ globIgnorePaths: declaredIgnores, mount, shadowDirectory });
	if (mount.childName === undefined) {
		mount.target.$path = shadow;
		return [];
	}

	mount.target[mount.childName] = { $path: shadow };
	// Expressed the way rojo expresses the candidate it is matching: the
	// relative `$path` of the enclosing mount, joined with the entry name.
	// `relativizeProjectPaths` puts every `$path` in that same frame.
	return [normalizeWindowsPath(path.relative(projectDirectory, mount.source))];
}

function findStage({ tree }: RojoTreeNode): RojoTreeNode | undefined {
	if (!isRojoTreeNode(tree)) {
		return undefined;
	}

	const serverStorage = tree["ServerStorage"];
	if (!isRojoTreeNode(serverStorage)) {
		return undefined;
	}

	const stage = serverStorage[STAGE_KEY];
	return isRojoTreeNode(stage) ? stage : undefined;
}

function readGlobIgnorePaths({ globIgnorePaths: value }: RojoTreeNode): Array<string> {
	return Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === "string")
		: [];
}

/**
 * Whether the project already drops a path, so a stand-in must not resurrect
 * it. A consumer who hit this bug before the pipeline handled it worked around
 * it by ignoring the offending file; rebuilding it as a Folder would undo that
 * and put an empty stand-in back in the place.
 *
 * Matched with and without the drive letter, because a declared pattern is
 * written against whatever frame the consumer's project expresses its mounts
 * in, and a leading globstar has to reach either one.
 */
function isIgnored(patterns: ReadonlyArray<string>): (absolutePath: string) => boolean {
	if (patterns.length === 0) {
		return () => false;
	}

	const match = picomatch([...patterns], { dot: true });
	return (absolutePath: string) => {
		const normalized = normalizeWindowsPath(absolutePath);
		return match(normalized) || match(normalized.replace(DRIVE_LETTER, ""));
	};
}

function pinnedClassesOf(filePath: string): Array<string> {
	return readDeclaredClasses(filePath).filter((declared) => PINNED_PARENT_CLASSES.has(declared));
}

/** A directory entry as an absolute posix path, the frame every scan uses. */
function entryPathOf(directory: string, entryName: string): string {
	return path.posix.join(normalizeWindowsPath(directory), entryName);
}

/**
 * Whether a directory's own `init.meta.json` gives the instance rojo mounts for
 * it a class the engine pins.
 */
function declaresPinnedClass(directory: string, entries: ReadonlyArray<fs.Dirent>): boolean {
	const hasMeta = entries.some((child) => child.name === META_JSON_FILE && !child.isDirectory());
	return hasMeta && pinnedClassesOf(entryPathOf(directory, META_JSON_FILE)).length > 0;
}

/**
 * A class the engine pins is legal only directly under the one parent it is
 * pinned to, so a source tree that mirrors a working place always sits such a
 * file directly inside the mount for that parent. One buried deeper already
 * sits under the wrong parent in the consumer's own place, and no stand-in
 * this module writes would make it load — so it is reported rather than
 * rebuilt.
 */
function assertNoDeeperPinnedClass({
	directory,
	entries,
	mountRoot,
	walk,
}: {
	directory: string;
	entries: ReadonlyArray<fs.Dirent>;
	mountRoot: string;
	walk: Walk;
}): void {
	for (const entry of entries) {
		const entryPath = entryPathOf(directory, entry.name);
		if (walk.ignored(entryPath)) {
			continue;
		}

		if (entry.isDirectory()) {
			assertNoDeeperPinnedClass({
				directory: entryPath,
				entries: fs.readdirSync(entryPath, { withFileTypes: true }),
				mountRoot,
				walk,
			});
			continue;
		}

		const [buried] = pinnedClassesOf(entryPath);
		if (buried !== undefined) {
			throw new ConfigError(
				`"${entryPath}" declares ${buried}, which the engine parents only under one service, but it is nested inside the mount at "${mountRoot}" rather than sitting directly in it. ` +
					"Roblox rejects it wherever that mount lands, so move the file up to the directory mounted at its own service, or drop it from the project with `globIgnorePaths`.",
			);
		}
	}
}

/**
 * One entry of an auto-mounted directory: a model file, or a directory whose
 * `init.meta.json` names the class. A directory that names none is walked only
 * to report a pinned class buried below it.
 */
function collectDirectoryEntry({
	entry,
	mountPath,
	target,
	walk,
}: {
	entry: fs.Dirent;
	mountPath: string;
	target: RojoTreeNode;
	walk: Walk;
}): PinnedMount | undefined {
	const entryPath = entryPathOf(mountPath, entry.name);
	if (walk.ignored(entryPath)) {
		return undefined;
	}

	if (!entry.isDirectory()) {
		// `init.meta.json` gives the class to the directory holding it, which the
		// caller has already asked about. Mounting it as a child of its own would
		// hand rojo a lone descriptor it cannot turn into an Instance.
		if (entry.name === META_JSON_FILE || pinnedClassesOf(entryPath).length === 0) {
			return undefined;
		}

		return { childName: mountedName(entry.name), source: entryPath, target };
	}

	// One listing answers both questions — whether this directory declares a
	// class of its own, and what a deeper scan would walk. Probing for the meta
	// file by opening it would miss for nearly every directory in the tree, and
	// a failed open plus a thrown Error is the expensive way to ask.
	const entries = fs.readdirSync(entryPath, { withFileTypes: true });
	if (declaresPinnedClass(entryPath, entries)) {
		return { childName: mountedName(entry.name), source: entryPath, target };
	}

	assertNoDeeperPinnedClass({ directory: entryPath, entries, mountRoot: mountPath, walk });
	return undefined;
}

function collectMountEntries({
	mountPath,
	target,
	walk,
}: {
	mountPath: string;
	target: RojoTreeNode;
	walk: Walk;
}): void {
	const key = normalizeWindowsPath(mountPath);
	if (walk.ignored(mountPath) || walk.scanned.has(key)) {
		return;
	}

	walk.scanned.add(key);

	if (isModelFile(mountPath)) {
		if (pinnedClassesOf(mountPath).length > 0) {
			walk.pinned.push({ childName: undefined, source: mountPath, target });
		}

		return;
	}

	const stats = fs.statSync(mountPath, { throwIfNoEntry: false });
	if (stats?.isDirectory() !== true) {
		return;
	}

	const entries = fs.readdirSync(mountPath, { withFileTypes: true });
	// The mount's own `init.meta.json` classes the instance rojo builds for the
	// whole mount, so a pinned one makes the mount itself the offender — the
	// node already names it, and no child stands in.
	if (declaresPinnedClass(mountPath, entries)) {
		walk.pinned.push({ childName: undefined, source: mountPath, target });
		return;
	}

	for (const entry of entries) {
		const mount = collectDirectoryEntry({ entry, mountPath, target, walk });
		if (mount !== undefined) {
			walk.pinned.push(mount);
		}
	}
}

function collectPinnedMounts(node: RojoTreeNode, walk: Walk): void {
	const mountPath = node.$path;
	if (typeof mountPath === "string") {
		collectMountEntries({ mountPath, target: node, walk });
	}

	for (const [key, value] of Object.entries(node)) {
		if (!key.startsWith("$") && isRojoTreeNode(value)) {
			collectPinnedMounts(value, walk);
		}
	}
}
