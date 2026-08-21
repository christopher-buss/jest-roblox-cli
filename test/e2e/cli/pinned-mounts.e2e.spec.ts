import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";

import { buildPlace } from "../../../src/staging/place-builder.ts";
import { rojoOnPath } from "./helpers.ts";

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

const STAGE_NAME = "__pkg_stage";
const ITEM_OPEN = /<Item\s+class="([^"]+)"[^>]*>|<\/Item>|<string name="Name">([^<]*)</g;
const INSTANCE_NAME = /<string name="Name">([^<]*)</g;

/** An `Item` the walk has opened but not yet closed. */
interface OpenItem {
	/** True once the `Name` property has been read, which comes first. */
	named: boolean;
	/** True when this item is the stage itself, so the close can pop it. */
	stage: boolean;
}

/** Flags the enclosing item as the stage, reporting the depth it adds. */
function markStage(item: OpenItem | undefined, name: string): number {
	if (item === undefined || item.named) {
		return 0;
	}

	item.named = true;
	item.stage = name === STAGE_NAME;
	return item.stage ? 1 : 0;
}

/**
 * Classes found inside `ServerStorage.__pkg_stage`, by `Item` nesting rather
 * than byte offset — the place's own services serialize after the stage does,
 * and an offset check would read them as staged.
 */
function stagedClasses(placeFile: string): Set<string> {
	const open: Array<OpenItem> = [];
	const found = new Set<string>();
	let depth = 0;

	for (const [, opened, name] of fs.readFileSync(placeFile, "utf-8").matchAll(ITEM_OPEN)) {
		if (opened !== undefined) {
			open.push({ named: false, stage: false });
			if (depth > 0) {
				found.add(opened);
			}
		} else if (name !== undefined) {
			depth += markStage(open.at(-1), name);
		} else {
			depth -= open.pop()?.stage === true ? 1 : 0;
		}
	}

	return found;
}

/** A model whose root instance is a service, as a place round-trip produces. */
function serviceModel(rootClass: string, childName: string): string {
	return [
		'<roblox version="4">',
		`  <Item class="${rootClass}" referent="0">`,
		"    <Properties>",
		`      <string name="Name">${rootClass}</string>`,
		"    </Properties>",
		'    <Item class="ModuleScript" referent="1">',
		"      <Properties>",
		`        <string name="Name">${childName}</string>`,
		'        <ProtectedString name="Source">return 1</ProtectedString>',
		"      </Properties>",
		"    </Item>",
		"  </Item>",
		"</roblox>",
	].join("\n");
}

/**
 * A package whose rojo project mounts a directory of service-rooted models:
 * what a place round-trip writes out, and what the synthesizer alone cannot
 * see, because the class lives in the file rather than in the project.
 */
function buildFixturePlace(models: Record<string, string>): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pinned-mounts-e2e-"));
	onTestFinished(() => {
		fs.rmSync(root, { force: true, recursive: true });
	});

	const assets = path.join(root, "game-assets/StarterPlayer");
	fs.mkdirSync(assets, { recursive: true });
	for (const [rootClass, childName] of Object.entries(models)) {
		fs.writeFileSync(
			path.join(assets, `${rootClass}.rbxmx`),
			serviceModel(rootClass, childName),
		);
	}

	const rojoProjectPath = path.join(root, "test.project.json");
	fs.writeFileSync(
		rojoProjectPath,
		JSON.stringify({
			name: "fixture",
			tree: {
				$className: "DataModel",
				StarterPlayer: { $className: "StarterPlayer", $path: "game-assets/StarterPlayer" },
			},
		}),
	);

	const placeFile = path.join(root, "out/place.rbxlx");
	buildPlace({
		packages: [{ name: "fixture", packageDirectory: root, rojoProjectPath }],
		placeFile,
		projectFile: path.join(root, "cache/synth.project.json"),
	});

	return placeFile;
}

describe.skipIf(!rojoOnPath())("staged pinned classes", () => {
	it("should build a place with no parent-pinned class inside the stage", () => {
		expect.assertions(2);

		const staged = stagedClasses(
			buildFixturePlace({
				StarterCharacterScripts: "CharacterModule",
				StarterPlayerScripts: "ClientModule",
			}),
		);

		expect([...staged].filter((entry) => PINNED_CLASSES.has(entry))).toStrictEqual([]);
		// The stand-in is not an empty one: the materializer clones these
		// children into the live service, so losing them would be the same
		// failure by a quieter route.
		expect(staged).toContain("ModuleScript");
	});

	it("should keep the instance names the package's own mount would have built", () => {
		expect.assertions(1);

		const placeFile = buildFixturePlace({ StarterPlayerScripts: "ClientModule" });
		// The materializer matches the live sub-service by name, and exactly one
		// node may carry it — a duplicate would mean the ignored original came
		// back alongside the stand-in.
		const names = Array.from(
			fs.readFileSync(placeFile, "utf-8").matchAll(INSTANCE_NAME),
			([, name]) => name,
		);

		expect(names.filter((name) => name === "StarterPlayerScripts")).toHaveLength(1);
	});
});
