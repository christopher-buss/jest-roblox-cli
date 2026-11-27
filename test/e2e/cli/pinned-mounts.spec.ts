import { describe, it } from "vitest";

import {
	buildFixturePlaceAsync,
	FIXTURE_PACKAGE,
	modelXml,
} from "#test/helpers/e2e/place-fixture.ts";
import { descendants, nodeAt, readPlaceTree } from "#test/helpers/e2e/place-tree.ts";
import { rojoOnPath } from "#test/helpers/integration/helpers.ts";

const PINNED_CLASSES = new Set([
	"Lighting",
	"ReplicatedStorage",
	"ServerScriptService",
	"ServerStorage",
	"StarterCharacterScripts",
	"StarterGui",
	"StarterPack",
	"StarterPlayer",
	"StarterPlayerScripts",
	"Terrain",
	"Workspace",
]);

const STAGE_PATH = ["ServerStorage", "__pkg_stage"] as const;

function serviceModel(rootClass: string, childName: string): string {
	return modelXml({
		name: rootClass,
		children: [
			{
				name: childName,
				instanceClass: "ModuleScript",
				properties: ['<ProtectedString name="Source">return 1</ProtectedString>'],
			},
		],
		instanceClass: rootClass,
	});
}

async function buildServiceModelPlaceAsync(models: Record<string, string>): Promise<string> {
	return buildFixturePlaceAsync({
		files: Object.fromEntries(
			Object.entries(models).map(([rootClass, childName]) => [
				`${rootClass}.rbxmx`,
				serviceModel(rootClass, childName),
			]),
		),
		service: "StarterPlayer",
	});
}

describe.skipIf(!rojoOnPath())("staged pinned classes", () => {
	it("should build a place with no parent-pinned class inside the stage", async ({ expect }) => {
		expect.assertions(2);

		const placeFile = await buildServiceModelPlaceAsync({
			StarterCharacterScripts: "CharacterModule",
			StarterPlayerScripts: "ClientModule",
		});
		const staged = descendants(nodeAt(readPlaceTree(placeFile), STAGE_PATH));
		const stagedClasses = new Set(staged.map((node) => node.instanceClass));

		expect([...stagedClasses].filter((entry) => PINNED_CLASSES.has(entry))).toStrictEqual([]);
		// The stand-in is not an empty one: the materializer clones these
		// children into the live service, so losing them would be the same
		// failure by a quieter route.
		expect(stagedClasses).toContain("ModuleScript");
	});

	it("should keep the instance names the package's own mount would have built", async ({
		expect,
	}) => {
		expect.assertions(1);

		const placeFile = await buildServiceModelPlaceAsync({
			StarterPlayerScripts: "ClientModule",
		});
		const tree = readPlaceTree(placeFile);
		const standIn = nodeAt(tree, [
			...STAGE_PATH,
			FIXTURE_PACKAGE,
			"StarterPlayer",
			"StarterPlayerScripts",
		]);

		// The materializer matches the live sub-service by name, and exactly one
		// node may carry it. A duplicate would mean the ignored original came
		// back alongside the stand-in. The one that survives is the stand-in,
		// where the materializer walks for it; anywhere else it never reaches
		// the live service.
		expect(
			descendants(tree).filter((node) => node.name === "StarterPlayerScripts"),
		).toStrictEqual([standIn]);
	});
});
