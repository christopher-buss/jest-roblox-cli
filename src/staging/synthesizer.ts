import { loadRojoProject } from "@isentinel/rojo-utils";

import * as path from "node:path";

import type { RojoTreeNode } from "../types/rojo.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";

export interface PackageDescriptor {
	name: string;
	packageDirectory: string;
	rojoProjectPath: string;
}

interface SynthesizeInput {
	packages: Array<PackageDescriptor>;
}

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

export function synthesize(input: SynthesizeInput): string {
	const stage: RojoTreeNode = { $className: "Folder" };

	for (const descriptor of input.packages) {
		const project = loadRojoProject(descriptor.rojoProjectPath);
		const folder = transformToFolder(project.tree);
		stage[descriptor.name] = absolutizePaths(folder, path.dirname(descriptor.rojoProjectPath));
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

function absolutizePaths(node: RojoTreeNode, base: string): RojoTreeNode {
	const result: RojoTreeNode = {};
	for (const [key, value] of Object.entries(node)) {
		if (key === "$path" && typeof value === "string") {
			result[key] = normalizeWindowsPath(path.resolve(base, value));
			continue;
		}

		if (!key.startsWith("$") && isTreeNode(value)) {
			result[key] = absolutizePaths(value, base);
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
