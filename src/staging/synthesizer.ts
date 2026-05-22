import { loadRojoProject } from "@isentinel/rojo-utils";

import * as fs from "node:fs";
import * as path from "node:path";

import { ConfigError } from "../config/errors.ts";
import { redirectPathToShadow } from "../coverage/redirect-path.ts";
import type { RojoTreeNode } from "../types/rojo.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";

export interface StubMount {
	absStubPath: string;
	dataModelPath: string;
}

export interface CoverageRoot {
	/** Path relative to `packageDirectory` that points at the original luau root. */
	luauRoot: string;
	/** Absolute path to the instrumented shadow directory for the same root. */
	shadowDir: string;
}

export interface PackageDescriptor {
	name: string;
	/**
	 * Per-package `coverageCache` opt-out, forwarded to
	 * `prepareWorkspaceCoverage` so the cache gate honors each package's own
	 * declaration. Not read by synthesis itself.
	 */
	coverageCache?: boolean;
	/**
	 * Per-package coverage ignore patterns, forwarded to
	 * `prepareWorkspaceCoverage` so the matcher reflects the merged pkgConfig
	 * instead of the workspace-root default. Not read by synthesis itself.
	 */
	coveragePathIgnorePatterns?: Array<string>;
	/**
	 * When set, $path entries that fall inside any listed `luauRoot` are
	 * redirected to the corresponding `shadowDir` so the synthesized place
	 * picks up instrumented sources for this package only. Packages without
	 * `coverageRoots` use their original $path entries unchanged.
	 */
	coverageRoots?: Array<CoverageRoot>;
	/**
	 * Per-package `luauRoots`, forwarded to `prepareWorkspaceCoverage` so the
	 * short-circuit honors the user-listed source dirs. Not read by synthesis
	 * itself.
	 */
	luauRoots?: Array<string>;
	packageDirectory: string;
	rojoProjectPath: string;
	stubMounts?: Array<StubMount>;
}

interface SynthesizeInput {
	packages: Array<PackageDescriptor>;
	/**
	 * Default `true`: wrap each package under `ServerStorage.__pkg_stage.<name>`
	 * (multi-package workspace mode). Set to `false` for single-package
	 * coverage — the package's project tree is emitted verbatim so the runtime
	 * layout matches a direct `rojo build`.
	 */
	wrap?: boolean;
}

const STUB_INJECTION_KEY = "jest.config";
const COLLIDING_SOURCE_FILES = ["jest.config.lua", "jest.config.luau"];

const SERVICE_CLASSES = new Set([
	"Chat",
	"CollectionService",
	"DataModel",
	"HttpService",
	"Lighting",
	"LocalizationService",
	"MarketplaceService",
	"MaterialService",
	"MessagingService",
	"Players",
	"ReplicatedFirst",
	"ReplicatedStorage",
	"RunService",
	"ServerScriptService",
	"ServerStorage",
	"SoundService",
	"StarterPlayer",
	"StarterPlayerScripts",
	"Teams",
	"TestService",
	"TextChatService",
	"TweenService",
	"UserInputService",
	"Workspace",
]);

const SERVICE_PROPERTIES = new Set(["AutoRuns", "ExecuteWithStudioRun", "LoadStringEnabled"]);

interface AbsolutizeOptions {
	/** Base for resolving `coverageRoots[].luauRoot`. Typically `packageDirectory`. */
	coverageBase: string;
	coverageRoots: Array<CoverageRoot> | undefined;
}

export function synthesize(input: SynthesizeInput): string {
	if (input.wrap === false) {
		return synthesizeNoWrap(input.packages);
	}

	const stage: RojoTreeNode = { $className: "Folder" };

	for (const descriptor of input.packages) {
		const project = loadRojoProject(descriptor.rojoProjectPath);
		const folder = transformToFolder(project.tree);
		const root = absolutizePaths(folder, path.dirname(descriptor.rojoProjectPath), {
			coverageBase: descriptor.packageDirectory,
			coverageRoots: descriptor.coverageRoots,
		});
		injectStubMounts(root, descriptor.stubMounts);
		stage[descriptor.name] = root;
	}

	const tree: RojoTreeNode = {
		$className: "DataModel",
		ServerScriptService: {
			$className: "ServerScriptService",
			$properties: { LoadStringEnabled: true },
		},
		ServerStorage: {
			$className: "ServerStorage",
			__pkg_stage: stage,
		},
	};

	return stableStringify({ name: "jest-roblox-workspace", tree });
}

function sortKeys(value: unknown): unknown {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return value;
	}

	const source = value as Record<string, unknown>;
	const sorted: Record<string, unknown> = {};
	for (const key of Object.keys(source).sort()) {
		sorted[key] = sortKeys(source[key]);
	}

	return sorted;
}

function stableStringify(value: unknown): string {
	return String(JSON.stringify(sortKeys(value), undefined, 2));
}

function isTreeNode(value: RojoTreeNode[string]): value is RojoTreeNode {
	return typeof value === "object" && !("optional" in value);
}

function resolveDollarPath(
	value: string,
	treeBase: string,
	coverageBase: string,
	coverageRoots: Array<CoverageRoot> | undefined,
): string {
	const absoluteTarget = normalizeWindowsPath(path.resolve(treeBase, value));

	if (coverageRoots === undefined) {
		return absoluteTarget;
	}

	// `$path` resolves against `treeBase` (rojo project directory) per rojo's
	// convention. `luauRoot` resolves against `coverageBase` (package
	// directory) because that's the documented contract for coverage roots,
	// and the two diverge whenever a project file lives in a subdirectory of
	// its package. Trailing slash on `luauRoot` is stripped so `$path: "out/"`
	// matches `luauRoot: "out"` exactly.
	const resolvedRoots = coverageRoots.map((root) => {
		return {
			luauRoot: normalizeWindowsPath(path.resolve(coverageBase, root.luauRoot)).replace(
				/\/$/,
				"",
			),
			shadowDir: normalizeWindowsPath(root.shadowDir),
		};
	});

	return redirectPathToShadow(absoluteTarget, resolvedRoots) ?? absoluteTarget;
}

function absolutizePaths(
	node: RojoTreeNode,
	treeBase: string,
	options: AbsolutizeOptions,
): RojoTreeNode {
	const result: RojoTreeNode = {};
	for (const [key, value] of Object.entries(node)) {
		if (key === "$path" && typeof value === "string") {
			result[key] = resolveDollarPath(
				value,
				treeBase,
				options.coverageBase,
				options.coverageRoots,
			);
			continue;
		}

		if (!key.startsWith("$") && isTreeNode(value)) {
			result[key] = absolutizePaths(value, treeBase, options);
			continue;
		}

		result[key] = value;
	}

	return result;
}

function demoteAutoMountToExplicit(parent: RojoTreeNode, parentPath: string): void {
	const entries = fs.readdirSync(parentPath, { withFileTypes: true });
	for (const entry of entries) {
		if (entry.name.startsWith("$")) {
			continue;
		}

		if (parent[entry.name] !== undefined) {
			continue;
		}

		// Non-directory entries (loose files) are skipped because rojo only
		// `$path`-mounts a fixed set of known source extensions. Feeding rojo
		// an unsupported extension (e.g. `tsconfig.tsbuildinfo`) via `$path`
		// hard-errors at build time. Directories cover every real use we've
		// seen of nested project mounts.
		if (!entry.isDirectory()) {
			continue;
		}

		const entryPath = path.posix.join(parentPath, entry.name);
		parent[entry.name] = { $path: normalizeWindowsPath(entryPath) };
	}

	delete parent.$path;
	parent.$className ??= "Folder";
}

function virtualizePathChild(parent: RojoTreeNode, segment: string): RojoTreeNode | undefined {
	const parentPath = parent.$path;
	if (typeof parentPath !== "string") {
		return undefined;
	}

	const childPath = path.posix.join(parentPath, segment);
	const stat = fs.statSync(childPath, { throwIfNoEntry: false });
	if (stat?.isDirectory() !== true) {
		return undefined;
	}

	// Rojo does not merge a `$path` auto-mount with explicit children sharing
	// the same name — adding `segment` alongside the parent's `$path` produces
	// a duplicate sibling at build time, and `FindFirstChild` lookups in the
	// runtime hit the auto-mounted twin (without our stub injection) first.
	// Demote the parent by enumerating disk directories at `parentPath`,
	// promoting each to an explicit `$path` child, and dropping the parent's
	// `$path`. The result is the same set of Instances rojo would have built
	// from the auto-mount, but each child is now reachable by the synthesizer
	// for stub injection.
	demoteAutoMountToExplicit(parent, parentPath);

	const child = parent[segment];
	return isTreeNode(child) ? child : undefined;
}

function walkToLeaf(root: RojoTreeNode, dataModelPath: string): RojoTreeNode {
	let cursor: RojoTreeNode = root;
	for (const segment of dataModelPath.split("/")) {
		let next = cursor[segment];
		if (!isTreeNode(next)) {
			const virtualized = virtualizePathChild(cursor, segment);
			if (virtualized !== undefined) {
				cursor[segment] = virtualized;
				next = virtualized;
			}
		}

		if (!isTreeNode(next)) {
			throw new ConfigError(
				`stubMount dataModelPath "${dataModelPath}" does not resolve in synthesized tree (missing segment "${segment}")`,
			);
		}

		cursor = next;
	}

	return cursor;
}

function assertNoSourceCollision(leaf: RojoTreeNode, dataModelPath: string): void {
	const leafPath = leaf.$path;
	if (typeof leafPath !== "string") {
		return;
	}

	for (const candidate of COLLIDING_SOURCE_FILES) {
		// `fs.existsSync` needs the OS-native path; only the rojo $path
		// injection further down needs POSIX normalization.
		const sourceFile = path.join(leafPath, candidate);
		if (fs.existsSync(sourceFile)) {
			throw new ConfigError(
				`stubMount at "${dataModelPath}" would collide with existing source file "${normalizeWindowsPath(sourceFile)}" (rojo silently duplicates jest.config children)`,
			);
		}
	}
}

function injectStubMounts(root: RojoTreeNode, stubMounts: Array<StubMount> | undefined): void {
	if (!stubMounts) {
		return;
	}

	for (const mount of stubMounts) {
		const leaf = walkToLeaf(root, mount.dataModelPath);
		assertNoSourceCollision(leaf, mount.dataModelPath);
		// Structural collision: the user's project tree already declares a
		// `jest.config` named-child at this leaf (e.g. they mounted a
		// config explicitly via `$path`). Refusing to overwrite catches
		// non-filesystem conflicts the source-collision check can't see.
		if (leaf[STUB_INJECTION_KEY] !== undefined) {
			throw new ConfigError(
				`stubMount at "${mount.dataModelPath}" would overwrite an existing "${STUB_INJECTION_KEY}" child already declared in the project tree. ` +
					"Either remove the explicit declaration from your .project.json, or declare the project via a string entry in `projects: [...]` so jest-roblox treats your config as canonical.",
			);
		}

		leaf[STUB_INJECTION_KEY] = {
			$path: normalizeWindowsPath(mount.absStubPath),
		};
	}
}

function synthesizeNoWrap(packages: Array<PackageDescriptor>): string {
	if (packages.length !== 1) {
		throw new ConfigError(
			`synthesize wrap:false requires exactly one package, got ${String(packages.length)}`,
		);
	}

	// eslint-disable-next-line ts/no-non-null-assertion -- length-1 invariant
	const descriptor = packages[0]!;
	const project = loadRojoProject(descriptor.rojoProjectPath);
	const tree = absolutizePaths(project.tree, path.dirname(descriptor.rojoProjectPath), {
		coverageBase: descriptor.packageDirectory,
		coverageRoots: descriptor.coverageRoots,
	});

	// Inject in no-wrap mode too so single-package callers (multi-project +
	// open-cloud) share the same `$path` named-child mounting workspace uses.
	injectStubMounts(tree, descriptor.stubMounts);

	// `raw` carries top-level fields (gameId, placeId, globIgnorePaths, etc.)
	// that the narrow `RojoProject` shape strips; `tree` then overrides the
	// raw unresolved tree with the loader's resolved version.
	return stableStringify({ ...project.raw, tree });
}

function transformToFolder(node: RojoTreeNode): RojoTreeNode {
	const folder: RojoTreeNode = { $className: "Folder" };
	for (const [key, value] of Object.entries(node)) {
		if (key === "$className" || key === "$properties") {
			continue;
		}

		folder[key] = transformValue(key, value);
	}

	return folder;
}

function transformChild(node: RojoTreeNode): RojoTreeNode {
	const result: RojoTreeNode = {};
	for (const [key, value] of Object.entries(node)) {
		const transformed = transformChildEntry(key, value);
		if (transformed !== undefined) {
			result[key] = transformed;
		}
	}

	return result;
}

function filterServiceProperties(props: Record<string, unknown>): Record<string, unknown> {
	const filtered: Record<string, unknown> = {};
	for (const [propertyKey, propertyValue] of Object.entries(props)) {
		if (!SERVICE_PROPERTIES.has(propertyKey)) {
			filtered[propertyKey] = propertyValue;
		}
	}

	return filtered;
}

function isProperties(value: RojoTreeNode[string]): value is Record<string, unknown> {
	return typeof value === "object" && !Array.isArray(value);
}

function transformChildEntry(
	key: string,
	value: RojoTreeNode[string],
): RojoTreeNode[string] | undefined {
	if (key === "$className" && typeof value === "string" && SERVICE_CLASSES.has(value)) {
		return "Folder";
	}

	if (key === "$properties" && isProperties(value)) {
		const filtered = filterServiceProperties(value);
		return Object.keys(filtered).length > 0 ? filtered : undefined;
	}

	return transformValue(key, value);
}

function transformValue(key: string, value: RojoTreeNode[string]): RojoTreeNode[string] {
	if (key.startsWith("$") || !isTreeNode(value)) {
		return value;
	}

	const child = transformChild(value);

	// A node named after a service relies on Rojo's implicit service inference
	// at the DataModel root (e.g. a bare `ServerScriptService` with no
	// `$className`). Once relocated under `__pkg_stage` it is a plain folder, so
	// it needs an explicit `$className` or Rojo rejects it as missing info.
	if (SERVICE_CLASSES.has(key) && child.$className === undefined && child.$path === undefined) {
		child.$className = "Folder";
	}

	return child;
}
