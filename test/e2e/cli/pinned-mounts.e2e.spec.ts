import { describe, expect, it } from "vitest";

import { rojoOnPath } from "./helpers.ts";
import { buildFixturePlaceAsync, FIXTURE_PACKAGE, modelXml } from "./place-fixture.ts";
import { descendants, nodeAt, readPlaceTree } from "./place-tree.ts";

/**
 * The staged-tree fix has no unit seam that can prove it: whether a class the
 * engine pins reaches the place depends on what rojo reads out of a model file,
 * which only a real `rojo build` decides. So this drives one, then walks the
 * built place and asserts on where the classes landed.
 */

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

/** A model whose root instance is a service, as a place round-trip produces. */
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

/**
 * A package whose rojo project mounts a directory of service-rooted models:
 * what a place round-trip writes out, and what the synthesizer alone cannot
 * see, because the class lives in the file rather than in the project.
 */
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
	it("should build a place with no parent-pinned class inside the stage", async () => {
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

	it("should keep the instance names the package's own mount would have built", async () => {
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
		// node may carry it — a duplicate would mean the ignored original came
		// back alongside the stand-in. The one that survives is the stand-in,
		// where the materializer walks for it; anywhere else it never reaches
		// the live service.
		expect(
			descendants(tree).filter((node) => node.name === "StarterPlayerScripts"),
		).toStrictEqual([standIn]);
	});
});
