import { isRojoTreeNode } from "@isentinel/rojo-utils";

import { Buffer } from "node:buffer";
import * as path from "node:path";

import type { ChildProcessRunner } from "../utils/child-process.ts";
import { nodeChildProcessRunner } from "../utils/child-process.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";
import { hashBuffer } from "../utils/hash.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import { buildWithRojoAsync } from "../utils/rojo-builder.ts";
import { readGlobIgnorePaths } from "./glob-ignore.ts";
import type { PinnedMount } from "./pinned-mount-scan.ts";
import { findPinnedMounts } from "./pinned-mount-scan.ts";
import { PINNED_PARENT_CLASSES } from "./pinned-parent-classes.ts";
import { findStage } from "./stage.ts";

/** Inputs to {@link demotePinnedMountsAsync}. */
export interface DemotePinnedMountsOptions {
	/** Runs rojo. Defaults to the real child-process runner. */
	childProcess?: ChildProcessRunner;
	/**
	 * Where the stand-ins are read and written. Defaults to the real
	 * filesystem.
	 */
	fileSystem?: FileSystem;
	/** The directory the synthesized project file is written to. */
	projectDirectory: string;
	/** The synthesized project, serialized. */
	projectJson: string;
	/** Where the rewritten stand-in models are written. */
	shadowDirectory: string;
}

/**
 * What {@link demotePinnedMountsAsync} would emit, as a number the place-reuse
 * key can hold. Bump it whenever this module would produce different bytes
 * from unchanged sources — a class added to `PINNED_PARENT_CLASSES`, a
 * different fold, a different stand-in layout.
 *
 * The key covers this pass's inputs and not the pass, so without a bump a
 * place built by the old rule reads as current and is handed out unchanged.
 */
export const PINNED_MOUNT_PASS_VERSION = 1;

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
 *
 * A change to what this emits from unchanged sources needs
 * {@link PINNED_MOUNT_PASS_VERSION} bumped with it; the place-reuse key reads
 * this pass through that number and through nothing else.
 * @param options - Project text, directories and adapters.
 * @returns The rewritten project text, or the input unchanged when nothing is pinned.
 * @rejects When a scan finds a buried pinned class or a rojo build fails.
 */
export async function demotePinnedMountsAsync({
	childProcess = nodeChildProcessRunner,
	fileSystem = nodeFileSystem,
	projectDirectory,
	projectJson,
	shadowDirectory,
}: DemotePinnedMountsOptions): Promise<string> {
	const project = JSON.parse(projectJson);
	if (!isRojoTreeNode(project)) {
		return projectJson;
	}

	const stage = findStage(project);
	if (stage === undefined) {
		return projectJson;
	}

	const declaredIgnores = readGlobIgnorePaths(project);
	const pinned = findPinnedMounts({ fileSystem, globIgnorePaths: declaredIgnores, stage });
	if (pinned.length === 0) {
		return projectJson;
	}

	fileSystem.mkdirSync(shadowDirectory, { recursive: true });
	const ignores = await buildStandInsAsync(pinned, {
		childProcess,
		declaredIgnores,
		fileSystem,
		projectDirectory,
		shadowDirectory,
	});

	// Written through Reflect: a rojo tree node holds instance children, and the
	// static shape has no slot for the project-level list this appends to.
	Reflect.set(project, "globIgnorePaths", [...ignores]);
	return JSON.stringify(project, undefined, 2);
}

/**
 * Enough of a hash of the source path to keep two stand-in names apart.
 * @param source - Source path to hash.
 * @returns The first eight hex digits of the normalized path's hash.
 */
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
 * @param xml - Built `.rbxmx` text.
 * @returns The text with pinned classes folded to `Folder`.
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
 * @param options - The mount and where its stand-in goes.
 * @param options.childProcess - Runs rojo.
 * @param options.fileSystem - Writes the project and stand-in files.
 * @param options.globIgnorePaths - The consumer's own ignore patterns.
 * @param options.mount - Offending mount to rebuild.
 * @param options.shadowDirectory - Directory the stand-in is written to.
 * @returns Path of the written stand-in.
 * @rejects When the rojo build fails.
 */
async function writeFolderShadowAsync({
	childProcess,
	fileSystem,
	globIgnorePaths,
	mount,
	shadowDirectory,
}: {
	childProcess: ChildProcessRunner;
	fileSystem: FileSystem;
	globIgnorePaths: Array<string>;
	mount: PinnedMount;
	shadowDirectory: string;
}): Promise<string> {
	const { name } = mount;
	// Named for the instance, disambiguated by a digest of the source path: two
	// mounts can build a `StarterPlayerScripts`, and the digest keeps the name
	// stable across runs so an unchanged tree rebuilds byte-identical bytes and
	// the place-reuse key still matches.
	const directory = normalizeWindowsPath(shadowDirectory);
	const stem = `${name}-${sourceDigest(mount.source)}`;
	const projectFile = path.posix.join(directory, `${stem}.project.json`);
	const shadowFile = path.posix.join(directory, `${stem}.rbxmx`);

	fileSystem.writeFileSync(
		projectFile,
		JSON.stringify({
			// Rojo names the built root after the project, and the stand-in has
			// to answer to the same name the original mount did.
			name,
			globIgnorePaths,
			tree: { $path: normalizeWindowsPath(mount.source) },
		}),
	);
	await buildWithRojoAsync({ childProcess, outputPath: shadowFile, projectPath: projectFile });

	fileSystem.writeFileSync(
		shadowFile,
		foldPinnedClasses(fileSystem.readFileSync(shadowFile, "utf-8")),
	);
	return shadowFile;
}

/**
 * Build one mount's stand-in and point the tree at it, reporting the paths the
 * project now has to ignore — none when the node already names the instance,
 * and the replaced original when the stand-in joins a directory auto-mount that
 * would otherwise re-add it alongside.
 * @param mount - Offending mount; its target node is mutated.
 * @param options - Adapters, ignore patterns and directories.
 * @param options.childProcess - Runs rojo.
 * @param options.declaredIgnores - The consumer's own ignore patterns.
 * @param options.fileSystem - Writes the stand-in files.
 * @param options.projectDirectory - Frame the returned ignore paths are relative to.
 * @param options.shadowDirectory - Directory the stand-in is written to.
 * @returns Paths the project must now ignore.
 * @rejects When the rojo build fails.
 */
async function standInForAsync(
	mount: PinnedMount,
	{
		childProcess,
		declaredIgnores,
		fileSystem,
		projectDirectory,
		shadowDirectory,
	}: {
		childProcess: ChildProcessRunner;
		declaredIgnores: Array<string>;
		fileSystem: FileSystem;
		projectDirectory: string;
		shadowDirectory: string;
	},
): Promise<Array<string>> {
	// Only the consumer's own patterns reach the child build: a generated entry
	// names a path relative to `projectDirectory`, which resolves against
	// nothing in a project that lives in `shadowDirectory`.
	const shadow = await writeFolderShadowAsync({
		childProcess,
		fileSystem,
		globIgnorePaths: declaredIgnores,
		mount,
		shadowDirectory,
	});
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

/**
 * Build every pinned mount's stand-in, in order, and report the ignore list the
 * project now needs — the declared entries plus whatever each stand-in
 * replaced. Serial rather than concurrent: two mounts can build the same
 * instance name, and the digest that keeps their files apart is no help if two
 * rojo runs write the shadow directory at once.
 * @param pinned - Offending mounts.
 * @param options - Adapters, declared ignores and directories.
 * @returns The full ignore list.
 * @rejects When a rojo build fails.
 */
async function buildStandInsAsync(
	pinned: Array<PinnedMount>,
	options: {
		childProcess: ChildProcessRunner;
		declaredIgnores: Array<string>;
		fileSystem: FileSystem;
		projectDirectory: string;
		shadowDirectory: string;
	},
): Promise<Set<string>> {
	const ignores = new Set(options.declaredIgnores);
	for (const mount of pinned) {
		const replacements = await standInForAsync(mount, options);
		for (const replaced of replacements) {
			ignores.add(replaced);
		}
	}

	return ignores;
}
