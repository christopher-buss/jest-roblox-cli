import type { RojoTreeNode } from "@isentinel/rojo-utils";

import { ConfigError } from "../config/errors.ts";
import { isTreeNode } from "./tree-node-guards.ts";

/** One step of a hoisted service's path from the place root. */
export interface HoistedServiceSegment {
	/** Instance name of the node at this step. */
	name: string;
	/** Class the synthesized node declares when it is created. */
	serviceClass: string;
}

/**
 * A service whose `$properties` were lifted out of a package's staged tree.
 */
export interface HoistedService {
	/** The lifted `$properties`. */
	properties: JSONObject;
	/** Path from the place root; empty names the DataModel. */
	segments: Array<HoistedServiceSegment>;
}

/** The services one package lifted, named for conflict reports. */
export interface PackageHoist {
	/** Package named in a conflict report. */
	packageName: string;
	/** Services lifted from the package's tree. */
	services: ReadonlyArray<HoistedService>;
}

/**
 * Whether two JSON values serialize identically.
 * @param left - First value.
 * @param right - Second value.
 * @returns True when their `JSON.stringify` output matches.
 */
export function isSameValue(left: JSONValue, right: JSONValue): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Fold every package's hoisted services into one set, keyed by DataModel path.
 * @param hoists - Each package's hoisted services.
 * @returns One service per DataModel path with the merged properties.
 * @throws {ConfigError} When two packages set one property differently.
 */
export function mergeHoistedServices(hoists: ReadonlyArray<PackageHoist>): Array<HoistedService> {
	const merged = new Map<string, HoistedService>();
	const owners = new Map<string, { packageName: string; value: JSONValue }>();

	for (const { packageName, services } of hoists) {
		for (const service of services) {
			const pathKey = service.segments.map((segment) => segment.name).join("/");
			let target = merged.get(pathKey);
			if (target === undefined) {
				target = {
					properties: {},
					segments: service.segments,
				};
				merged.set(pathKey, target);
			}

			mergeServiceProperties({ owners, packageName, service, target });
		}
	}

	return [...merged.values()];
}

/**
 * Write the hoisted properties onto real services of the synthesized place.
 * @param tree - Synthesized place tree; mutated.
 * @param hoisted - Merged services to apply.
 */
export function applyHoistedServices(
	tree: RojoTreeNode,
	hoisted: ReadonlyArray<HoistedService>,
): void {
	for (const service of hoisted) {
		let cursor = tree;
		for (const segment of service.segments) {
			const existing = cursor[segment.name];
			const node = isTreeNode(existing) ? existing : {};
			node.$className ??= segment.serviceClass;
			cursor[segment.name] = node;
			cursor = node;
		}

		cursor.$properties = { ...service.properties };
	}
}

function propertyLabel(nodePath: ReadonlyArray<string>, property: string): string {
	return [...(nodePath.length > 0 ? nodePath : ["DataModel"]), property].join(".");
}

function formatPropertyConflict({
	label,
	owner,
	rival,
}: {
	label: string;
	owner: { packageName: string; value: unknown };
	rival: { packageName: string; value: unknown };
}): string {
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

function mergeServiceProperties({
	owners,
	packageName,
	service,
	target,
}: {
	owners: Map<string, { packageName: string; value: JSONValue }>;
	packageName: string;
	service: HoistedService;
	target: HoistedService;
}): void {
	const pathNames = service.segments.map((segment) => segment.name);
	const pathKey = pathNames.join("/");

	for (const [property, value] of Object.entries(service.properties)) {
		const ownerKey = `${pathKey}.${property}`;
		const owner = owners.get(ownerKey);
		if (owner !== undefined && !isSameValue(owner.value, value)) {
			throw new ConfigError(
				formatPropertyConflict({
					label: propertyLabel(pathNames, property),
					owner,
					rival: {
						packageName,
						value,
					},
				}),
			);
		}

		target.properties[property] = value;
		owners.set(ownerKey, { packageName, value });
	}
}
