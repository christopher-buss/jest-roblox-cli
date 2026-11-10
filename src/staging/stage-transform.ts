import type { RojoTreeNode } from "@isentinel/rojo-utils";

import { PINNED_PARENT_CLASSES } from "./pinned-parent-classes.ts";
import type { HoistedService, HoistedServiceSegment } from "./service-hoist.ts";
import { isProperties, isTreeNode } from "./tree-node-guards.ts";

interface TransformEntry {
	key: string;
	hoisted: Array<HoistedService>;
	isService: boolean;
	nodePath: Array<string>;
	value: RojoTreeNode[string];
}

/**
 * Demote a project root to a Folder, lifting its services' `$properties` out.
 * @param node - Root node of a package's tree.
 * @param hoisted - Receives the lifted service properties; mutated.
 * @returns A Folder-rooted copy with every service node demoted.
 */
export function transformToFolder(
	node: RojoTreeNode,
	hoisted: Array<HoistedService>,
): RojoTreeNode {
	const folder: RojoTreeNode = { $className: "Folder" };

	const isPlace = node.$className === "DataModel";

	for (const [key, value] of Object.entries(node)) {
		if (key === "$className") {
			continue;
		}

		if (key === "$properties") {
			if (isPlace) {
				recordHoistedProperties({ hoisted, segments: [], value });
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

function recordHoistedProperties({
	hoisted,
	segments,
	value,
}: {
	hoisted: Array<HoistedService>;
	segments: Array<HoistedServiceSegment>;
	value: RojoTreeNode[string];
}): void {
	if (!isProperties(value) || Object.keys(value).length === 0) {
		return;
	}

	hoisted.push({ properties: value, segments });
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

	return transformChild({ hoisted, isService, node: value, nodePath });
}

function recoverBareNodeClass(node: RojoTreeNode): void {
	if (node.$className === undefined && node.$path === undefined) {
		node.$className = "Folder";
	}
}

function hoistedServicePath(
	nodePath: Array<string>,
	declaredClass: string | undefined,
): Array<HoistedServiceSegment> {
	// oxlint-disable-next-line typescript/no-non-null-assertion -- only non-root nodes call this helper
	const leafName = nodePath.at(-1)!;
	const parents = nodePath.slice(0, -1).map((name) => ({ name, serviceClass: name }));
	return [...parents, { name: leafName, serviceClass: declaredClass ?? leafName }];
}

function transformChild({
	hoisted,
	isService,
	node,
	nodePath,
}: Pick<TransformEntry, "hoisted" | "isService" | "nodePath"> & {
	node: RojoTreeNode;
}): RojoTreeNode {
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
			const segments = hoistedServicePath(nodePath, declaredClass);
			recordHoistedProperties({ hoisted, segments, value });
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
