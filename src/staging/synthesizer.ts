import { PLACE_CONTENT_ID_NAME, PLACE_CONTENT_ID_SERVICE } from "@isentinel/roblox-runner";
import { loadRojoProject } from "@isentinel/rojo-utils";

import { ConfigError } from "../config/errors.ts";
import type { RojoTreeNode } from "../types/rojo.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";
import { absolutizePackagePaths } from "./absolutize-paths.ts";
import { readGlobIgnorePaths } from "./glob-ignore.ts";
import type { HoistedService, PackageHoist } from "./service-hoist.ts";
import { applyHoistedServices, isSameValue, mergeHoistedServices } from "./service-hoist.ts";
import { transformToFolder } from "./stage-transform.ts";
import { STAGE_KEY } from "./stage.ts";
import { injectStubMounts } from "./stub-injection.ts";
import type {
	PackageDescriptor,
	PackageSynthesisInput,
	UnwrappedPackageSynthesisInput,
} from "./synthesizer-types.ts";
import { isProperties, isTreeNode } from "./tree-node-guards.ts";

interface SynthesizeOptions {
	/**
	 * The Place Content Id to stamp into the synthesized place, as a
	 * `StringValue` at `ReplicatedStorage.__place_content_id`. A task that
	 * booted the place reads it back and compares, which is how a run proves
	 * the place holds the build it was collected against rather than trusting
	 * the version number the publish minted. Omitted ⇒ no stamp, and the place
	 * carries no identity beyond its version.
	 */
	contentId?: string | undefined;
	/** Where the tree is probed. Defaults to the real filesystem. */
	fileSystem?: FileSystem;
	/**
	 * Force `ServerScriptService.LoadStringEnabled = true` on the synthesized
	 * place. The wrap (workspace) path always sets it; this flag is for the
	 * no-wrap path (studio-cli's Clean Place), whose Run-mode runner gates on
	 * LoadString. Merged into any existing `ServerScriptService`, preserving
	 * its `$path`/children/other properties.
	 */
	loadStringEnabled?: boolean | undefined;
}

type SynthesizeInput = PackageSynthesisInput & SynthesizeOptions;
type UnwrappedSynthesizeInput = SynthesizeOptions & UnwrappedPackageSynthesisInput;

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

interface DeclaredGlobs {
	packageName: string;
	patterns: Array<string>;
}

/** The tree a package is staged into, and what reads the package off disk. */
interface StagingTarget {
	fileSystem: FileSystem;
	stage: RojoTreeNode;
}

/**
 * Synthesize one rojo project for the packages, staged or emitted unwrapped.
 * @param input - Packages, layout, content id and file system.
 * @returns The project text with sorted keys.
 * @throws {ConfigError} When packages conflict, a stub cannot mount, or an unwrapped run has other than one package.
 */
export function synthesize(input: SynthesizeInput): string {
	if (input.wrap === false) {
		return synthesizeNoWrap(input);
	}

	const { fileSystem = nodeFileSystem } = input;
	const stage: RojoTreeNode = { $className: "Folder" };
	const hoists: Array<PackageHoist> = [];
	const globs: Array<DeclaredGlobs> = [];

	for (const descriptor of input.packages) {
		stagePackage({ descriptor, fileSystem, globs, hoists, stage });
	}

	const tree: RojoTreeNode = {
		$className: "DataModel",
		ServerStorage: {
			$className: "ServerStorage",
			[STAGE_KEY]: stage,
		},
	};

	applyHoistedServices(tree, mergeHoistedServices(hoists));

	// After the hoist, so a package that declares `LoadStringEnabled: false`
	// cannot switch off the loadstring the Run-mode runner needs.
	enableLoadString(tree);
	stampPlaceContentId(tree, input.contentId);

	const globIgnorePaths = resolveGlobIgnorePaths(globs);

	return stableStringify({
		name: "jest-roblox-workspace",
		globIgnorePaths,
		tree,
	});
}

/**
 * {@link readGlobIgnorePaths}, telling a package that declared none apart from
 * one that declared an empty list: only a declaration takes part in the
 * consensus every package's list has to agree on.
 * @param raw - Raw project object.
 * @returns The patterns, or `undefined` when the field is not an array.
 */
function readDeclaredGlobIgnorePaths(raw: JSONObject): Array<string> | undefined {
	return Array.isArray(raw["globIgnorePaths"]) ? readGlobIgnorePaths(raw) : undefined;
}

/**
 * `emitLegacyScripts` is deliberately not carried onto the synthesized place.
 * Under `false` a `.server.luau` becomes a `Script` with `RunContext = Server`,
 * which the engine runs wherever it sits — so the staged copy would run at
 * place load, before any package is materialized, and again once it is. The
 * place is built with legacy emission instead, which parks staged scripts inert
 * under `ServerStorage`, and this attribute tells the materializer to restore
 * the requested run context on each clone before it enters a live service.
 * @param root - Package root node; mutated.
 * @param raw - Raw project object.
 */
function markRunContextScripts(root: RojoTreeNode, raw: JSONObject): void {
	if (raw["emitLegacyScripts"] !== false) {
		return;
	}

	const attributes = isProperties(root["$attributes"]) ? root["$attributes"] : {};
	root["$attributes"] = { ...attributes, JestRunContextScripts: true };
}

function stagePackage({
	descriptor,
	fileSystem,
	globs,
	hoists,
	stage,
}: StagingTarget & {
	descriptor: PackageDescriptor;
	globs: Array<DeclaredGlobs>;
	hoists: Array<PackageHoist>;
}): void {
	const project = loadRojoProject(descriptor.rojoProjectPath, fileSystem);
	const services: Array<HoistedService> = [];
	const folder = transformToFolder(project.tree, services);
	const root = absolutizePackagePaths({ descriptor, fileSystem, node: folder });
	injectStubMounts({ fileSystem, root, stubMounts: descriptor.stubMounts });
	markRunContextScripts(root, project.raw);
	stage[descriptor.name] = root;
	hoists.push({ packageName: descriptor.name, services });

	const patterns = readDeclaredGlobIgnorePaths(project.raw);
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

/**
 * One synthesized place means one ignore list, so the packages that declare
 * `globIgnorePaths` have to declare the same one. A package that declares none
 * has no opinion and does not constrain the rest; two that declare different
 * lists cannot both be honored, and picking one silently would drop the other's
 * files out of the place with no diagnostic.
 * @param globs - Each declaring package's patterns.
 * @returns The agreed patterns, or `undefined` when no package declares any.
 * @throws {ConfigError} When two packages declare different lists.
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
 * The tree's node for one service, created where the project never declared it
 * and given its canonical class where the project declared it only implicitly.
 * Rojo infers a service's class from its name, but a node this code then hangs
 * a property or a child on has to say what it is. Returned already attached, so
 * a caller mutates the node the tree holds rather than writing a copy back.
 * @param tree - Place tree; mutated.
 * @param name - Service name, which is also its class.
 * @returns The attached service node.
 */
function openService(tree: RojoTreeNode, name: string): RojoTreeNode {
	const existing = tree[name];
	// Rojo names a service by its class, so the tree key is the class name.
	const service = isTreeNode(existing) ? existing : {};
	service.$className ??= name;
	tree[name] = service;
	return service;
}

/**
 * Force `ServerScriptService.LoadStringEnabled = true` on a no-wrap tree,
 * creating the service node if the user's project omits it and merging into
 * any existing `$properties` so a hand-set property is preserved. The
 * studio-cli Run-mode runner gates on LoadString, so the Clean Place must
 * enable it regardless of what the user's `.project.json` declares.
 * @param tree - Place tree; mutated.
 */
function enableLoadString(tree: RojoTreeNode): void {
	const service = openService(tree, "ServerScriptService");
	const properties = isProperties(service.$properties) ? service.$properties : {};
	service.$properties = { ...properties, LoadStringEnabled: true };
}

/**
 * Park the place's content identity where a booted task can read it back, at
 * the service and name `@isentinel/roblox-runner` spells: it owns the guard
 * that reads the stamp, so it owns where the stamp lives.
 *
 * A `StringValue` rather than a file mount because rojo builds one from the
 * project text alone — nothing to stage, and the id therefore rides in the
 * same text the reuse key is taken over, so a place built for another id can
 * never be handed back for this one. Merged into whatever node the project
 * already declares for that service, so one that mounts a `$path` keeps it.
 * @param tree - Place tree; mutated.
 * @param contentId - Id to stamp, or `undefined` to stamp nothing.
 */
function stampPlaceContentId(tree: RojoTreeNode, contentId: string | undefined): void {
	if (contentId === undefined) {
		return;
	}

	openService(tree, PLACE_CONTENT_ID_SERVICE)[PLACE_CONTENT_ID_NAME] = {
		$className: "StringValue",
		$properties: { Value: contentId },
	};
}

function synthesizeNoWrap({
	contentId,
	fileSystem = nodeFileSystem,
	loadStringEnabled = false,
	packages,
}: UnwrappedSynthesizeInput): string {
	if (packages.length !== 1) {
		throw new ConfigError(
			`synthesize wrap:false requires exactly one package, got ${String(packages.length)}`,
		);
	}

	// oxlint-disable-next-line typescript/no-non-null-assertion -- length-1 invariant
	const descriptor = packages[0]!;
	const project = loadRojoProject(descriptor.rojoProjectPath, fileSystem);
	const tree = absolutizePackagePaths({ descriptor, fileSystem, node: project.tree });

	// Inject in no-wrap mode too so single-package callers (multi-project +
	// open-cloud) share the same `$path` named-child mounting workspace uses.
	injectStubMounts({ fileSystem, root: tree, stubMounts: descriptor.stubMounts });

	if (loadStringEnabled) {
		enableLoadString(tree);
	}

	stampPlaceContentId(tree, contentId);

	// `raw` carries top-level fields (gameId, placeId, globIgnorePaths, etc.)
	// that the narrow `RojoProject` shape strips; `tree` then overrides the
	// raw unresolved tree with the loader's resolved version.
	return stableStringify({ ...project.raw, tree });
}
