import { loadRojoProject } from "@isentinel/rojo-utils";

import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";

import { ConfigError } from "../config/errors.ts";
import { redirectPathToShadow } from "../coverage-pipeline/redirect-path.ts";
import {
	collectRojoMounts,
	unreachableRootWarning,
} from "../coverage-pipeline/root-reachability.ts";
import type { RojoTreeNode } from "../types/rojo.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import { PINNED_PARENT_CLASSES } from "./pinned-parent-classes.ts";

export interface StubMount {
	absStubPath: string;
	dataModelPath: string;
}

export interface CoverageRoot {
	/**
	 * Path relative to `packageDirectory` that points at the original luau
	 * root.
	 */
	luauRoot: string;
	/** Absolute path to the instrumented shadow directory for the same root. */
	shadowDir: string;
}

export interface PackageDescriptor {
	name: string;
	/**
	 * Per-package `collectCoverageFrom`, forwarded to
	 * `prepareWorkspaceCoverage` so instrumentation narrows to the files the
	 * package reports on. Not read by synthesis itself.
	 */
	collectCoverageFrom?: Array<string> | undefined;
	/**
	 * Per-package `coverageCache` opt-out, forwarded to
	 * `prepareWorkspaceCoverage` so the cache gate honors each package's own
	 * declaration. Not read by synthesis itself.
	 */
	coverageCache?: boolean | undefined;
	/**
	 * Per-package `coverageCopyIgnorePatterns`, forwarded to
	 * `prepareWorkspaceCoverage` so the shadow tree leaves out what this
	 * package's config says it should. Not read by synthesis itself.
	 */
	coverageCopyIgnorePatterns?: Array<string> | undefined;
	/**
	 * Per-package coverage ignore patterns, forwarded to
	 * `prepareWorkspaceCoverage` so the matcher reflects the merged pkgConfig
	 * instead of the workspace-root default. Not read by synthesis itself.
	 */
	coveragePathIgnorePatterns?: Array<string> | undefined;
	/**
	 * When set, $path entries that fall inside any listed `luauRoot` are
	 * redirected to the corresponding `shadowDir` so the synthesized place
	 * picks up instrumented sources for this package only. Packages without
	 * `coverageRoots` use their original $path entries unchanged.
	 */
	coverageRoots?: Array<CoverageRoot> | undefined;
	/**
	 * The directories between each `coverageRoots` entry and the `$path` mount
	 * above it, mapped to the shadow's copy of that directory's own loose
	 * files. A mount named here is demoted: its `$path` moves to the spine copy
	 * and every directory beneath it becomes an explicit child, so the coverage
	 * root can be swapped without the mount above serving the originals.
	 */
	coverageSpine?: Array<CoverageRoot> | undefined;
	/**
	 * Per-package `luauRoots`, forwarded to `prepareWorkspaceCoverage` so the
	 * short-circuit honors the user-listed source dirs. Not read by synthesis
	 * itself.
	 */
	luauRoots?: Array<string> | undefined;
	packageDirectory: string;
	rojoProjectPath: string;
	/**
	 * The package's own `rootDir`, forwarded to `prepareWorkspaceCoverage` so
	 * its coverage globs anchor where they were written. Not read by synthesis
	 * itself.
	 */
	rootDir?: string | undefined;
	stubMounts?: Array<StubMount> | undefined;
}

interface SynthesizeInput {
	/**
	 * Force `ServerScriptService.LoadStringEnabled = true` on the synthesized
	 * place. The wrap (workspace) path always sets it; this flag is for the
	 * no-wrap path (studio-cli's Clean Place), whose Run-mode runner gates on
	 * LoadString. Merged into any existing `ServerScriptService`, preserving
	 * its `$path`/children/other properties.
	 */
	loadStringEnabled?: boolean | undefined;
	packages: Array<PackageDescriptor>;
	/**
	 * Default `true`: wrap each package under
	 * `ServerStorage.__pkg_stage.<name>` (multi-package workspace mode). Set to
	 * `false` for single-package coverage — the package's project tree is
	 * emitted verbatim so the runtime layout matches a direct `rojo build`.
	 */
	wrap?: boolean | undefined;
}

const TRAILING_SLASH = /\/$/;
const STUB_INJECTION_KEY = "jest.config";
const COLLIDING_SOURCE_FILES = ["jest.config.lua", "jest.config.luau"];

interface JsonStringifyObject {
	[key: string]: JsonStringifyValue;
}

type JsonStringifyValue =
	| Array<JsonStringifyValue>
	| boolean
	| JsonStringifyObject
	| null
	| number
	| string
	| undefined;

interface AbsolutizeOptions {
	/** Each `luauRoot` made absolute, so the walk resolves it once. */
	coverageRoots: Array<CoverageRoot> | undefined;
	/**
	 * Absolute spine directory, by the absolute source directory it stands
	 * in for.
	 */
	spine: Map<string, string> | undefined;
}

/**
 * A service whose `$properties` were lifted out of a package's staged tree.
 *
 * Staging demotes every service to a Folder, and rojo rejects a service
 * property on one — `Unknown property Folder.StreamingEnabled` fails the whole
 * build. The properties are re-applied to the matching real service of the
 * synthesized place instead, which is also the only place they can take
 * effect: `Workspace.SignalBehavior` and friends are read-only once the place
 * is running, so no amount of runtime materializing could set them.
 */
interface HoistedService {
	/**
	 * Path from the place root, e.g. `["StarterPlayer",
	 * "StarterPlayerScripts"]`.
	 */
	path: Array<string>;
	properties: JSONObject;
	/** Declared `$className`, or the node name for a service rojo infers. */
	serviceClass: string;
}

interface DeclaredGlobs {
	packageName: string;
	patterns: Array<string>;
}

interface PackageHoist {
	packageName: string;
	services: ReadonlyArray<HoistedService>;
}

interface TransformEntry {
	key: string;
	hoisted: Array<HoistedService>;
	/** True only for a direct child of a place root, which is a service. */
	isService: boolean;
	nodePath: Array<string>;
	value: RojoTreeNode[string];
}

export function synthesize(input: SynthesizeInput): string {
	if (input.wrap === false) {
		return synthesizeNoWrap(input.packages, input.loadStringEnabled);
	}

	const stage: RojoTreeNode = { $className: "Folder" };
	const hoists: Array<PackageHoist> = [];
	const globs: Array<DeclaredGlobs> = [];

	for (const descriptor of input.packages) {
		stagePackage(descriptor, stage, hoists, globs);
	}

	const tree: RojoTreeNode = {
		$className: "DataModel",
		ServerStorage: {
			$className: "ServerStorage",
			__pkg_stage: stage,
		},
	};

	applyHoistedServices(tree, mergeHoistedServices(hoists));

	// After the hoist, so a package that declares `LoadStringEnabled: false`
	// cannot switch off the loadstring the Run-mode runner needs.
	enableLoadString(tree);

	const globIgnorePaths = resolveGlobIgnorePaths(globs);

	return stableStringify({
		name: "jest-roblox-workspace",
		globIgnorePaths,
		tree,
	});
}

function readGlobIgnorePaths(raw: JSONObject): Array<string> | undefined {
	const value = raw["globIgnorePaths"];
	return Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === "string")
		: undefined;
}

/**
 * `$path` resolves against the rojo project directory per rojo's convention.
 * `luauRoot` resolves against `coverageBase` (the package directory) because
 * that's the documented contract for coverage roots, and the two diverge
 * whenever a project file lives in a subdirectory of its package. Trailing
 * slash on `luauRoot` is stripped so `$path: "out/"` matches `luauRoot: "out"`
 * exactly.
 */
function resolveCoverageRoots(
	coverageBase: string,
	coverageRoots: Array<CoverageRoot> | undefined,
): Array<CoverageRoot> | undefined {
	return coverageRoots?.map((root) => {
		return {
			luauRoot: normalizeWindowsPath(path.resolve(coverageBase, root.luauRoot)).replace(
				TRAILING_SLASH,
				"",
			),
			shadowDir: normalizeWindowsPath(root.shadowDir),
		};
	});
}

/**
 * The spine directory for each source directory it stands in for, resolved the
 * same way `resolveCoverageRoots` resolves a root.
 */
function resolveSpine(descriptor: PackageDescriptor): Map<string, string> | undefined {
	const resolved = resolveCoverageRoots(descriptor.packageDirectory, descriptor.coverageSpine);
	return resolved === undefined
		? undefined
		: new Map(resolved.map((entry) => [entry.luauRoot, entry.shadowDir]));
}

/**
 * Say so when a coverage root no `$path` in this project reaches — off the
 * tree entirely, or nested below the mount that contains it. Either way the
 * shadow is built and the place loads the originals, so the run reports zero
 * coverage for that root with nothing else to show for the work.
 *
 * Workspace mode drops such a root before it reaches synthesis, so what this
 * catches in practice is single and multi mode, where `luauRoots` comes
 * straight from the config with no mount check of its own. No `subject`: the
 * descriptor there names a synthetic package the user never wrote.
 */
function warnUnreachableCoverageRoots(descriptor: PackageDescriptor, tree: RojoTreeNode): void {
	const { coverageRoots } = descriptor;
	if (coverageRoots === undefined) {
		return;
	}

	const mounts = collectRojoMounts(tree, path.dirname(descriptor.rojoProjectPath));
	for (const root of coverageRoots) {
		const warning = unreachableRootWarning({
			base: descriptor.packageDirectory,
			mounts,
			rawRoot: root.luauRoot,
		});
		if (warning !== undefined) {
			process.stderr.write(warning);
		}
	}
}

function isTreeNode(value: RojoTreeNode[string]): value is RojoTreeNode {
	return typeof value === "object" && !("optional" in value);
}

function resolveDollarPath(absoluteTarget: string, options: AbsolutizeOptions): string {
	if (options.coverageRoots === undefined) {
		return absoluteTarget;
	}

	return redirectPathToShadow(absoluteTarget, options.coverageRoots) ?? absoluteTarget;
}

function absolutizePaths(
	node: RojoTreeNode,
	treeBase: string,
	options: AbsolutizeOptions,
): RojoTreeNode {
	const result: RojoTreeNode = {};
	let mountTarget: string | undefined;
	for (const [key, value] of Object.entries(node)) {
		if (key === "$path" && typeof value === "string") {
			mountTarget = normalizeWindowsPath(path.resolve(treeBase, value));
			result[key] = resolveDollarPath(mountTarget, options);
			continue;
		}

		if (!key.startsWith("$") && isTreeNode(value)) {
			result[key] = absolutizePaths(value, treeBase, options);
			continue;
		}

		result[key] = value;
	}

	// After the loop, so a name the project declares for itself wins over the
	// sibling node the demote would otherwise invent for the same directory.
	return mountTarget === undefined ? result : demoteToSpine(result, mountTarget, options);
}

/** Both the wrap and no-wrap paths absolutize a package's tree through here. */
function absolutizePackagePaths(node: RojoTreeNode, descriptor: PackageDescriptor): RojoTreeNode {
	// Before the walk, while every `$path` still reads as the project wrote it.
	warnUnreachableCoverageRoots(descriptor, node);
	return absolutizePaths(node, path.dirname(descriptor.rojoProjectPath), {
		coverageRoots: resolveCoverageRoots(descriptor.packageDirectory, descriptor.coverageRoots),
		spine: resolveSpine(descriptor),
	});
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
	let cursor = root;
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

function isProperties(value: RojoTreeNode[string]): value is JSONObject {
	// `typeof null === "object"`, so guard it explicitly — a null `$properties`
	// from a malformed `.project.json` would otherwise reach
	// `Object.entries(null)` and throw. The static type excludes null (it's a
	// JSON-deserialization boundary), so the lint rule can't see the runtime
	// case the guard exists for.
	// eslint-disable-next-line ts/no-unnecessary-condition -- runtime JSON may be null
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordHoistedProperties(
	hoisted: Array<HoistedService>,
	serviceClass: string,
	nodePath: Array<string>,
	value: RojoTreeNode[string],
): void {
	if (!isProperties(value) || Object.keys(value).length === 0) {
		return;
	}

	hoisted.push({ path: nodePath, properties: value, serviceClass });
}

function transformToFolder(node: RojoTreeNode, hoisted: Array<HoistedService>): RojoTreeNode {
	const folder: RojoTreeNode = { $className: "Folder" };

	// Every direct child of a DataModel is a service by position, whatever it is
	// named — rojo infers the class from the key when `$className` is omitted.
	// Position beats the name set here, which only nested services (e.g.
	// `StarterPlayer.StarterPlayerScripts`) still need.
	const isPlace = node.$className === "DataModel";

	for (const [key, value] of Object.entries(node)) {
		if (key === "$className") {
			continue;
		}

		if (key === "$properties") {
			// A non-place root (a model project) has no service to hoist onto, so
			// its properties are dropped as before rather than moved onto a
			// Folder where rojo would reject them.
			if (isPlace) {
				recordHoistedProperties(hoisted, "DataModel", [], value);
			}

			continue;
		}

		folder[key] = transformNodeValue({
			key,
			hoisted,
			isService: isPlace,
			nodePath: [key],
			value,
		});
	}

	return folder;
}

/**
 * `emitLegacyScripts` is deliberately not carried onto the synthesized place.
 * Under `false` a `.server.luau` becomes a `Script` with `RunContext = Server`,
 * which the engine runs wherever it sits — so the staged copy would run at
 * place load, before any package is materialized, and again once it is. The
 * place is built with legacy emission instead, which parks staged scripts inert
 * under `ServerStorage`, and this attribute tells the materializer to restore
 * the requested run context on each clone before it enters a live service.
 */
function markRunContextScripts(root: RojoTreeNode, raw: JSONObject): void {
	if (raw["emitLegacyScripts"] !== false) {
		return;
	}

	const attributes = isProperties(root["$attributes"]) ? root["$attributes"] : {};
	root["$attributes"] = { ...attributes, JestRunContextScripts: true };
}

function stagePackage(
	descriptor: PackageDescriptor,
	stage: RojoTreeNode,
	hoists: Array<PackageHoist>,
	globs: Array<DeclaredGlobs>,
): void {
	const project = loadRojoProject(descriptor.rojoProjectPath);
	const services: Array<HoistedService> = [];
	const folder = transformToFolder(project.tree, services);
	const root = absolutizePackagePaths(folder, descriptor);
	injectStubMounts(root, descriptor.stubMounts);
	markRunContextScripts(root, project.raw);
	stage[descriptor.name] = root;
	hoists.push({ packageName: descriptor.name, services });

	const patterns = readGlobIgnorePaths(project.raw);
	if (patterns !== undefined) {
		globs.push({ packageName: descriptor.name, patterns });
	}
}

function formatGlobConflict(owner: DeclaredGlobs, rival: DeclaredGlobs): string {
	return [
		"workspace packages disagree on `globIgnorePaths`.",
		"",
		`  - ${JSON.stringify(owner.patterns)} — declared by ${owner.packageName}`,
		`  - ${JSON.stringify(rival.patterns)} — declared by ${rival.packageName}`,
		"",
		"Every package in a workspace run shares one synthesized place, so one",
		"ignore list covers every mount in it. Either align the list across each",
		"package's rojo project, or run the odd package on its own.",
	].join("\n");
}

function isSameValue(left: JSONValue, right: JSONValue): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * One synthesized place means one ignore list, so the packages that declare
 * `globIgnorePaths` have to declare the same one. A package that declares none
 * has no opinion and does not constrain the rest; two that declare different
 * lists cannot both be honored, and picking one silently would drop the other's
 * files out of the place with no diagnostic.
 */
function resolveGlobIgnorePaths(globs: ReadonlyArray<DeclaredGlobs>): Array<string> | undefined {
	const [first, ...rest] = globs;
	if (first === undefined) {
		return undefined;
	}

	for (const entry of rest) {
		if (!isSameValue(first.patterns.toSorted(), entry.patterns.toSorted())) {
			throw new ConfigError(formatGlobConflict(first, entry));
		}
	}

	return first.patterns;
}

function sortKeys(value: JsonStringifyValue): JsonStringifyValue {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return value;
	}

	const sorted: JsonStringifyObject = {};
	for (const key of Object.keys(value).sort()) {
		sorted[key] = sortKeys(value[key]);
	}

	return sorted;
}

function stableStringify(value: JsonStringifyValue): string {
	return String(JSON.stringify(sortKeys(value), undefined, 2));
}

/**
 * Force `ServerScriptService.LoadStringEnabled = true` on a no-wrap tree,
 * creating the service node if the user's project omits it and merging into
 * any existing `$properties` so a hand-set property is preserved. studio-cli's
 * Run-mode runner gates on LoadString, so the Clean Place must enable it
 * regardless of what the user's `.project.json` declares.
 */
function enableLoadString(tree: RojoTreeNode): void {
	const existing = tree["ServerScriptService"];
	const service = isTreeNode(existing) ? existing : { $className: "ServerScriptService" };
	service.$className ??= "ServerScriptService";

	const properties = isProperties(service.$properties) ? service.$properties : {};
	service.$properties = { ...properties, LoadStringEnabled: true };
	tree["ServerScriptService"] = service;
}

function synthesizeNoWrap(packages: Array<PackageDescriptor>, loadStringEnabled = false): string {
	if (packages.length !== 1) {
		throw new ConfigError(
			`synthesize wrap:false requires exactly one package, got ${String(packages.length)}`,
		);
	}

	// eslint-disable-next-line ts/no-non-null-assertion -- length-1 invariant
	const descriptor = packages[0]!;
	const project = loadRojoProject(descriptor.rojoProjectPath);
	const tree = absolutizePackagePaths(project.tree, descriptor);

	// Inject in no-wrap mode too so single-package callers (multi-project +
	// open-cloud) share the same `$path` named-child mounting workspace uses.
	injectStubMounts(tree, descriptor.stubMounts);

	if (loadStringEnabled) {
		enableLoadString(tree);
	}

	// `raw` carries top-level fields (gameId, placeId, globIgnorePaths, etc.)
	// that the narrow `RojoProject` shape strips; `tree` then overrides the
	// raw unresolved tree with the loader's resolved version.
	return stableStringify({ ...project.raw, tree });
}

/** `Workspace.StreamingEnabled`, or `DataModel.Name` for the place root. */
function propertyLabel(nodePath: ReadonlyArray<string>, property: string): string {
	return [...(nodePath.length > 0 ? nodePath : ["DataModel"]), property].join(".");
}

function formatPropertyConflict(
	label: string,
	owner: { packageName: string; value: unknown },
	rival: { packageName: string; value: unknown },
): string {
	return [
		`workspace packages disagree on \`${label}\`.`,
		"",
		`  - ${JSON.stringify(owner.value)} — declared by ${owner.packageName}`,
		`  - ${JSON.stringify(rival.value)} — declared by ${rival.packageName}`,
		"",
		"Every package in a workspace run shares one synthesized place, so a",
		"service property is a property of the whole run. Either align the value",
		"across each package's rojo project, or run the odd package on its own.",
	].join("\n");
}

function mergeServiceProperties(
	target: HoistedService,
	service: HoistedService,
	packageName: string,
	owners: Map<string, { packageName: string; value: JSONValue }>,
): void {
	const pathKey = service.path.join("/");

	for (const [property, value] of Object.entries(service.properties)) {
		const ownerKey = `${pathKey}.${property}`;
		const owner = owners.get(ownerKey);
		if (owner !== undefined && !isSameValue(owner.value, value)) {
			throw new ConfigError(
				formatPropertyConflict(propertyLabel(service.path, property), owner, {
					packageName,
					value,
				}),
			);
		}

		target.properties[property] = value;
		owners.set(ownerKey, { packageName, value });
	}
}

/**
 * Fold every package's hoisted services into one set, keyed by DataModel path.
 * Packages that set the same property to the same value agree and merge
 * silently; a genuine disagreement is unresolvable — one place cannot hold two
 * values — so it fails the run rather than letting load order pick a winner.
 */
function mergeHoistedServices(hoists: ReadonlyArray<PackageHoist>): Array<HoistedService> {
	const merged = new Map<string, HoistedService>();
	const owners = new Map<string, { packageName: string; value: JSONValue }>();

	for (const { packageName, services } of hoists) {
		for (const service of services) {
			const pathKey = service.path.join("/");
			let target = merged.get(pathKey);
			if (target === undefined) {
				target = {
					path: service.path,
					properties: {},
					serviceClass: service.serviceClass,
				};
				merged.set(pathKey, target);
			}

			mergeServiceProperties(target, service, packageName, owners);
		}
	}

	return [...merged.values()];
}

/**
 * Write the hoisted properties onto real services of the synthesized place,
 * creating each service node (and any intermediate one) on the way down. Only
 * properties travel — children stay staged under `__pkg_stage`, where the
 * materializer clones them into the live services per package.
 */
function applyHoistedServices(tree: RojoTreeNode, hoisted: ReadonlyArray<HoistedService>): void {
	for (const service of hoisted) {
		let cursor = tree;
		for (const [index, segment] of service.path.entries()) {
			const existing = cursor[segment];
			const node = isTreeNode(existing) ? existing : {};
			// An intermediate segment is a service rojo would infer from its own
			// name; only the leaf carries a class the package declared.
			node.$className ??= index === service.path.length - 1 ? service.serviceClass : segment;
			cursor[segment] = node;
			cursor = node;
		}

		// One entry per DataModel path — the merge already folded every package's
		// claim on this service together — so this assigns rather than merges.
		cursor.$properties = { ...service.properties };
	}
}

/**
 * The node one directory under a demoted mount becomes: the shadow when it is
 * a coverage root, a demote of its own when the spine carries on through it,
 * and the original directory otherwise.
 */
function spineChildNode(absoluteTarget: string, options: AbsolutizeOptions): RojoTreeNode {
	// `demoteToSpine` hands a node it does not demote straight back, so the
	// fallback is the node it is given rather than a second lookup here.
	return demoteToSpine(
		{ $path: resolveDollarPath(absoluteTarget, options) },
		absoluteTarget,
		options,
	);
}

/**
 * Rojo mounts a directory whole, so a coverage root below a `$path` cannot be
 * swapped in place: the mount keeps serving the originals. Demoting moves the
 * mount's `$path` onto a spine directory holding that directory's own loose
 * files — which is what keeps an `init.luau`, a `.meta.json` and every
 * extension rojo mounts for itself working — and promotes each directory
 * beneath it to an explicit child, pointed at the shadow or back at the source.
 *
 * A name the project already declares is left alone: it is the author's node,
 * and rojo would build both.
 */
function demoteToSpine(
	node: RojoTreeNode,
	absoluteTarget: string,
	options: AbsolutizeOptions,
): RojoTreeNode {
	const spineDirectory = options.spine?.get(absoluteTarget);
	if (spineDirectory === undefined) {
		return node;
	}

	node.$path = spineDirectory;
	const entries = fs.readdirSync(absoluteTarget, { withFileTypes: true });
	for (const entry of entries) {
		// A dollar-prefixed disk entry collides with rojo's own reserved keys,
		// the same reason `demoteAutoMountToExplicit` passes over one.
		if (!entry.isDirectory() || entry.name.startsWith("$") || node[entry.name] !== undefined) {
			continue;
		}

		node[entry.name] = spineChildNode(path.posix.join(absoluteTarget, entry.name), options);
	}

	return node;
}

function transformNodeValue({
	key,
	hoisted,
	isService,
	nodePath,
	value,
}: TransformEntry): RojoTreeNode[string] {
	if (key.startsWith("$") || !isTreeNode(value)) {
		return value;
	}

	return transformChild(value, nodePath, isService, hoisted);
}

/**
 * A bare node — no `$className`, no `$path` — is only legal at a DataModel
 * root, where rojo infers a service from the name. Once relocated under
 * `__pkg_stage` it needs an explicit class, and Folder is what every demoted
 * node becomes. Unconditional because a bare node rojo could not resolve at the
 * root is one it would reject here too. This also recovers a malformed
 * non-string `$className`, which is dropped rather than copied through.
 */
function recoverBareNodeClass(node: RojoTreeNode): void {
	if (node.$className === undefined && node.$path === undefined) {
		node.$className = "Folder";
	}
}

function transformChild(
	node: RojoTreeNode,
	nodePath: Array<string>,
	isService: boolean,
	hoisted: Array<HoistedService>,
): RojoTreeNode {
	const declaredClass = typeof node.$className === "string" ? node.$className : undefined;
	const isDemoted =
		isService || (declaredClass !== undefined && PINNED_PARENT_CLASSES.has(declaredClass));
	const result: RojoTreeNode = {};

	for (const [key, value] of Object.entries(node)) {
		if (key === "$className") {
			if (isDemoted) {
				result.$className = "Folder";
			} else if (declaredClass !== undefined) {
				result.$className = declaredClass;
			}

			continue;
		}

		if (key === "$properties" && isDemoted) {
			// eslint-disable-next-line ts/no-non-null-assertion -- non-root nodes always have a name
			recordHoistedProperties(hoisted, declaredClass ?? nodePath.at(-1)!, nodePath, value);
			continue;
		}

		result[key] = transformNodeValue({
			key,
			hoisted,
			isService: false,
			nodePath: [...nodePath, key],
			value,
		});
	}

	recoverBareNodeClass(result);

	return result;
}
