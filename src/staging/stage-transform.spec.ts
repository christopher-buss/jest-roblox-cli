import { isRojoTreeNode } from "@isentinel/rojo-utils";
import type { RojoTreeNode } from "@isentinel/rojo-utils";
import { fromAny } from "@total-typescript/shoehorn";

import { assert, describe, expect, it } from "vitest";

import type { HoistedService } from "./service-hoist.ts";
import { transformToFolder } from "./stage-transform.ts";

function transform(node: RojoTreeNode): { folder: RojoTreeNode; hoisted: Array<HoistedService> } {
	const hoisted: Array<HoistedService> = [];
	return { folder: transformToFolder(node, hoisted), hoisted };
}

describe(transformToFolder, () => {
	it("should demote every place-root service to a Folder and hoist its properties", () => {
		expect.assertions(2);

		const { folder, hoisted } = transform({
			$className: "DataModel",
			$properties: { Name: "place" },
			Workspace: { $className: "Workspace", $properties: { StreamingEnabled: true } },
		});

		expect(folder).toStrictEqual({
			$className: "Folder",
			Workspace: { $className: "Folder" },
		});
		expect(hoisted).toStrictEqual([
			{ properties: { Name: "place" }, segments: [] },
			{
				properties: { StreamingEnabled: true },
				segments: [{ name: "Workspace", serviceClass: "Workspace" }],
			},
		]);
	});

	it("should name the hoisted service after the node when it declares no class", () => {
		expect.assertions(1);

		const { hoisted } = transform({
			$className: "DataModel",
			Workspace: { $properties: { StreamingEnabled: true } },
		});

		expect(hoisted[0]!.segments).toStrictEqual([
			{ name: "Workspace", serviceClass: "Workspace" },
		]);
	});

	it("should hoist a nested pinned service with its parent path", () => {
		expect.assertions(2);

		const { folder, hoisted } = transform({
			$className: "DataModel",
			StarterPlayer: {
				$className: "StarterPlayer",
				StarterPlayerScripts: {
					$className: "StarterPlayerScripts",
					$properties: { Name: "scripts" },
				},
			},
		});

		expect(folder["StarterPlayer"]).toStrictEqual({
			$className: "Folder",
			StarterPlayerScripts: { $className: "Folder" },
		});
		expect(hoisted[0]!.segments).toStrictEqual([
			{ name: "StarterPlayer", serviceClass: "StarterPlayer" },
			{ name: "StarterPlayerScripts", serviceClass: "StarterPlayerScripts" },
		]);
	});

	it.for([{}, [], null, "not-an-object"])("should hoist nothing for $properties %o", (value) => {
		expect.assertions(1);

		const { hoisted } = transform({
			$className: "DataModel",
			Workspace: { $className: "Workspace", $properties: fromAny(value) },
		});

		expect(hoisted).toStrictEqual([]);
	});

	it("should drop root $properties for a project whose root is not a place", () => {
		expect.assertions(2);

		const { folder, hoisted } = transform({
			$className: "Model",
			$properties: { Name: "model" },
			Part: { $className: "Part", $properties: { Anchored: true } },
		});

		expect(hoisted).toStrictEqual([]);
		expect(folder["Part"]).toStrictEqual({
			$className: "Part",
			$properties: { Anchored: true },
		});
	});

	it("should recover a bare or malformed node as a Folder", () => {
		expect.assertions(3);

		const broken: RojoTreeNode = fromAny({ $className: 42 });
		const { folder } = transform({
			$className: "DataModel",
			ReplicatedStorage: {
				$className: "ReplicatedStorage",
				Bare: {},
				Broken: broken,
				Mounted: { $path: "src" },
			},
		});

		const storage = folder["ReplicatedStorage"];
		assert(isRojoTreeNode(storage));

		expect(storage["Bare"]).toStrictEqual({ $className: "Folder" });
		expect(storage["Broken"]).toStrictEqual({ $className: "Folder" });
		expect(storage["Mounted"]).toStrictEqual({ $path: "src" });
	});
});
