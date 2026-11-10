import { isRojoTreeNode } from "@isentinel/rojo-utils";

import { Buffer } from "node:buffer";
import * as path from "node:path";

import type { ChildProcessRunner } from "../utils/child-process.ts";
import type { FileSystem } from "../utils/file-system.ts";
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
	/** Runs rojo. */
	childProcess: ChildProcessRunner;
	/** Where the stand-ins are read and written. */
	fileSystem: FileSystem;
	/** The directory the synthesized project file is written to. */
	projectDirectory: string;
	/** The synthesized project, serialized. */
	projectJson: string;
	/** Where the rewritten stand-in models are written. */
	shadowDirectory: string;
}

/**
 * Pass version in the place-reuse key. Bump when this module emits different
 * bytes from unchanged sources, or stale places are reused.
 */
export const PINNED_MOUNT_PASS_VERSION = 1;

const PINNED_XML_CLASS = /(<Item\s+class=")([^"]+)(")/g;
// Must run before the class fold, which erases the class this keys on.
const CLASSED_PROPERTIES =
	/(<Item\s+class="([^"]+)"[^>]*>\s*<Properties>)([\s\S]*?)(<\/Properties>)/g;
const XML_PROPERTY = /<(\w+) name="([^"]+)"[^>]*>[\s\S]*?<\/\1>/g;
const INSTANCE_PROPERTIES = new Set(["AttributesSerialize", "Name", "Tags"]);

/**
 * Replace staged mounts that bring a parent-pinned class with Folders.
 * Output changes need {@link PINNED_MOUNT_PASS_VERSION} bumped.
 * @param options - Project text, directories and adapters.
 * @returns The rewritten project text, or the input when nothing is pinned.
 * @rejects When a scan finds a buried pinned class or a rojo build fails.
 */
export async function demotePinnedMountsAsync({
	childProcess,
	fileSystem,
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

	Reflect.set(project, "globIgnorePaths", [...ignores]);
	return JSON.stringify(project, undefined, 2);
}

function sourceDigest(source: string): string {
	return hashBuffer(Buffer.from(normalizeWindowsPath(source), "utf-8")).slice(0, 8);
}

/**
 * Strip properties before folding classes: after the fold, rewritten items
 * look like consumer-authored Folders.
 *
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
	// The name must stay stable across runs, or the place-reuse key misses.
	const directory = normalizeWindowsPath(shadowDirectory);
	const stem = `${name}-${sourceDigest(mount.source)}`;
	const projectFile = path.posix.join(directory, `${stem}.project.json`);
	const shadowFile = path.posix.join(directory, `${stem}.rbxmx`);

	fileSystem.writeFileSync(
		projectFile,
		JSON.stringify({
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
	// Must use the same frame `relativizeProjectPaths` gives every `$path`.
	return [normalizeWindowsPath(path.relative(projectDirectory, mount.source))];
}

/**
 * Keep serial: concurrent rojo runs can collide in the shadow directory.
 *
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
