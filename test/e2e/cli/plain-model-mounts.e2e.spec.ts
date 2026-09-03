import { describe, expect, it } from "vitest";

import { rojoOnPath } from "./helpers.ts";
import type { FixtureInstance } from "./place-fixture.ts";
import { buildFixturePlaceAsync, FIXTURE_PACKAGE, modelXml } from "./place-fixture.ts";
import { nodeAt, readPlaceTree } from "./place-tree.ts";

/**
 * The pass-through half of the staged-mount story: a model carrying no pinned
 * class is rojo's business alone, and the classes it holds have to reach the
 * place unchanged. `pinned-mounts.e2e.spec.ts` covers the other half, where a
 * class the engine pins is folded to a Folder stand-in.
 *
 * Both halves have to be driven through a real `rojo build`, because the class
 * of a mounted instance lives in the model file and only rojo reads it.
 */

const STAGE_PATH = ["ServerStorage", "__pkg_stage", FIXTURE_PACKAGE] as const;

/** A `Model` holding a `Part`, the shape a package's plain assets have. */
const PROP: FixtureInstance = {
	name: "Prop",
	children: [{ name: "Base", instanceClass: "Part" }],
	instanceClass: "Model",
};

describe.skipIf(!rojoOnPath())("staged plain models", () => {
	it("should stage a mounted model with its own class and children", async () => {
		expect.assertions(2);

		const placeFile = await buildFixturePlaceAsync({
			files: { "Prop.rbxmx": modelXml(PROP) },
			service: "ReplicatedStorage",
		});
		const model = nodeAt(readPlaceTree(placeFile), [
			...STAGE_PATH,
			"ReplicatedStorage",
			"Prop",
		]);

		// The class, not the name: a Folder stand-in answers to "Prop" as well,
		// and only the class tells the two apart.
		expect(model.instanceClass).toBe("Model");
		// One child, with its own class: a fold that reached this model would
		// leave the names looking right and the place unusable.
		expect(model.children).toStrictEqual([
			{ name: "Base", children: [], instanceClass: "Part" },
		]);
	});

	it("should leave a plain model alone inside a stand-in it was nested in", async () => {
		expect.assertions(2);

		// The fold rebuilds the whole offending mount through rojo and rewrites
		// classes across the result, so everything the mount held is in its
		// path. A model mounted on its own never reaches it —
		// `demotePinnedMounts` returns early when it collects nothing — which is
		// why the plain case above cannot speak for this one.
		const placeFile = await buildFixturePlaceAsync({
			files: {
				"StarterPlayerScripts.rbxmx": modelXml({
					name: "StarterPlayerScripts",
					children: [PROP],
					instanceClass: "StarterPlayerScripts",
				}),
			},
			service: "StarterPlayer",
		});
		const standIn = nodeAt(readPlaceTree(placeFile), [
			...STAGE_PATH,
			"StarterPlayer",
			"StarterPlayerScripts",
		]);

		// The fold ran: the pinned class the engine would reject under the stage
		// is gone. Without this the case could pass by the fold never running.
		expect(standIn.instanceClass).toBe("Folder");
		expect(standIn.children).toStrictEqual([
			{
				name: "Prop",
				children: [{ name: "Base", children: [], instanceClass: "Part" }],
				instanceClass: "Model",
			},
		]);
	});
});
