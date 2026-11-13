import { PLACE_CONTENT_ID_NAME, PLACE_CONTENT_ID_SERVICE } from "@isentinel/roblox-runner";
import { loadRojoProject } from "@isentinel/rojo-utils";
import type { RojoTreeNode } from "@isentinel/rojo-utils";

import { ConfigError } from "../config/errors.ts";
import { RUN_CONTEXT_ATTRIBUTE, STAGE_KEY } from "../protocol/staged-place.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { absolutizePackagePaths } from "./absolutize-paths.ts";
import { readDeclaredGlobIgnorePaths, withReplacedConfigs } from "./glob-ignore.ts";
import type { HoistedService, PackageHoist } from "./service-hoist.ts";
import { applyHoistedServices, isSameValue, mergeHoistedServices } from "./service-hoist.ts";
import { transformToFolder } from "./stage-transform.ts";
import { injectStubMounts } from "./stub-injection.ts";
import type {
	PackageDescriptor,
	PackageSynthesisInput,
	UnwrappedPackageSynthesisInput,
} from "./synthesizer-types.ts";
import { isProperties, isTreeNode } from "./tree-node-guards.ts";

interface SynthesizeOptions {
	contentId?: string | undefined;
	fileSystem: FileSystem;
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

interface StagingTarget {
	fileSystem: FileSystem;
	stage: RojoTreeNode;
}

/**
 * Synthesize one rojo project for the packages, staged or emitted unwrapped.
 * @param input - Packages, layout, content id and file system.
 * @returns The project text with sorted keys.
 * @throws {ConfigError} When packages conflict or a stub cannot mount.
 */
export function synthesize(input: SynthesizeInput): string {
	if (input.wrap === false) {
		return synthesizeNoWrap(input);
	}

	const { fileSystem } = input;
	const stage: RojoTreeNode = { $className: "Folder" };
	const hoists: Array<PackageHoist> = [];
	const globs: Array<DeclaredGlobs> = [];
	const replacedConfigs: Array<string> = [];

	for (const descriptor of input.packages) {
		replacedConfigs.push(...stagePackage({ descriptor, fileSystem, globs, hoists, stage }));
	}

	const tree: RojoTreeNode = {
		$className: "DataModel",
		ServerStorage: {
			$className: "ServerStorage",
			[STAGE_KEY]: stage,
		},
	};

	applyHoistedServices(tree, mergeHoistedServices(hoists));

	// Must run after the hoist, so no package can switch LoadString off.
	enableLoadString(tree);
	stampPlaceContentId(tree, input.contentId);

	const globIgnorePaths = withReplacedConfigs(resolveGlobIgnorePaths(globs), replacedConfigs);

	return stableStringify({
		name: "jest-roblox-workspace",
		globIgnorePaths,
		tree,
	});
}

/**
 * The materializer reads this attribute to restore the run context on clones.
 *
 * @param root - Package root node; mutated.
 * @param raw - Raw project object.
 */
function markRunContextScripts(root: RojoTreeNode, raw: JSONObject): void {
	if (raw["emitLegacyScripts"] !== false) {
		return;
	}

	const attributes = isProperties(root["$attributes"]) ? root["$attributes"] : {};
	root["$attributes"] = { ...attributes, [RUN_CONTEXT_ATTRIBUTE]: true };
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
}): Array<string> {
	const project = loadRojoProject(descriptor.rojoProjectPath, fileSystem);
	const services: Array<HoistedService> = [];
	const folder = transformToFolder(project.tree, services);
	const root = absolutizePackagePaths({ descriptor, fileSystem, node: folder });
	const replacedConfigs = injectStubMounts({
		fileSystem,
		root,
		stubMounts: descriptor.stubMounts,
	});
	markRunContextScripts(root, project.raw);
	stage[descriptor.name] = root;
	hoists.push({ packageName: descriptor.name, services });

	const patterns = readDeclaredGlobIgnorePaths(project.raw);
	if (patterns !== undefined) {
		globs.push({ packageName: descriptor.name, patterns });
	}

	return replacedConfigs;
}

function formatGlobConflict(owner: DeclaredGlobs, rival: DeclaredGlobs): string {
	return [
		"workspace packages disagree on `globIgnorePaths`.",
		"",
		`  - ${JSON.stringify(owner.patterns)} (declared by ${owner.packageName})`,
		`  - ${JSON.stringify(rival.patterns)} (declared by ${rival.packageName})`,
		"",
		"Every package in a workspace run shares one synthesized place, so one",
		"ignore list covers every mount in it. Either align the list across each",
		"package's rojo project, or run the odd package on its own.",
	].join("\n");
}

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

function openService(tree: RojoTreeNode, name: string): RojoTreeNode {
	const existing = tree[name];
	const service = isTreeNode(existing) ? existing : {};
	service.$className ??= name;
	tree[name] = service;
	return service;
}

function enableLoadString(tree: RojoTreeNode): void {
	const service = openService(tree, "ServerScriptService");
	const properties = isProperties(service.$properties) ? service.$properties : {};
	service.$properties = { ...properties, LoadStringEnabled: true };
}

/**
 * Must stay in the project text: the place-reuse key covers the id there.
 *
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
	fileSystem,
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

	const replacedConfigs = injectStubMounts({
		fileSystem,
		root: tree,
		stubMounts: descriptor.stubMounts,
	});

	if (loadStringEnabled) {
		enableLoadString(tree);
	}

	stampPlaceContentId(tree, contentId);

	return stableStringify({
		...project.raw,
		globIgnorePaths: withReplacedConfigs(
			readDeclaredGlobIgnorePaths(project.raw),
			replacedConfigs,
		),
		tree,
	});
}
