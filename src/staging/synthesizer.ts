import { loadRojoProject } from "@isentinel/rojo-utils";

import * as fs from "node:fs";
import * as path from "node:path";

import { ConfigError } from "../config/errors.ts";
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
	 * When set, $path entries that fall inside any listed `luauRoot` are
	 * redirected to the corresponding `shadowDir` so the synthesized place
	 * picks up instrumented sources for this package only. Packages without
	 * `coverageRoots` use their original $path entries unchanged.
	 */
	coverageRoots?: Array<CoverageRoot>;
	packageDirectory: string;
	rojoProjectPath: string;
	stubMounts?: Array<StubMount>;
}

interface SynthesizeInput {
	packages: Array<PackageDescriptor>;
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
	"TextChatService",
	"TweenService",
	"UserInputService",
	"Workspace",
]);

const SERVICE_PROPERTIES = new Set(["LoadStringEnabled"]);

interface AbsolutizeOptions {
	coverageRoots: Array<CoverageRoot> | undefined;
}

export function synthesize(input: SynthesizeInput): string {
	const stage: RojoTreeNode = { $className: "Folder" };

	for (const descriptor of input.packages) {
		const project = loadRojoProject(descriptor.rojoProjectPath);
		const folder = transformToFolder(project.tree);
		const root = absolutizePaths(folder, path.dirname(descriptor.rojoProjectPath), {
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

function isTreeNode(value: RojoTreeNode[string]): value is RojoTreeNode {
	return typeof value === "object" && !("optional" in value);
}

function resolveDollarPath(
	value: string,
	base: string,
	coverageRoots: Array<CoverageRoot> | undefined,
): string {
	const absoluteTarget = normalizeWindowsPath(path.resolve(base, value));

	if (coverageRoots !== undefined) {
		for (const root of coverageRoots) {
			// luauRoot is package-relative; resolve against the same base
			// (which is the rojo project dir, == package dir in the common
			// case) and strip any trailing slash before comparison so a
			// rojo `$path: "out/"` matches a `luauRoot: "out"` exactly.
			const absoluteRoot = normalizeWindowsPath(path.resolve(base, root.luauRoot)).replace(
				/\/$/,
				"",
			);
			if (absoluteTarget === absoluteRoot) {
				return normalizeWindowsPath(root.shadowDir);
			}

			if (absoluteTarget.startsWith(`${absoluteRoot}/`)) {
				const suffix = absoluteTarget.slice(absoluteRoot.length);
				return normalizeWindowsPath(root.shadowDir) + suffix;
			}
		}
	}

	return absoluteTarget;
}

function absolutizePaths(
	node: RojoTreeNode,
	base: string,
	options: AbsolutizeOptions,
): RojoTreeNode {
	const result: RojoTreeNode = {};
	for (const [key, value] of Object.entries(node)) {
		if (key === "$path" && typeof value === "string") {
			result[key] = resolveDollarPath(value, base, options.coverageRoots);
			continue;
		}

		if (!key.startsWith("$") && isTreeNode(value)) {
			result[key] = absolutizePaths(value, base, options);
			continue;
		}

		result[key] = value;
	}

	return result;
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

function walkToLeaf(root: RojoTreeNode, dataModelPath: string): RojoTreeNode {
	let cursor: RojoTreeNode = root;
	for (const segment of dataModelPath.split("/")) {
		const next = cursor[segment];
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
		leaf[STUB_INJECTION_KEY] = {
			$path: normalizeWindowsPath(mount.absStubPath),
		};
	}
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

	return transformChild(value);
}
