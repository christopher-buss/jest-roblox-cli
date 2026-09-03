import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { onTestFinished } from "vitest";

import { buildPlaceAsync } from "../../../src/staging/place-builder.ts";

/** One instance in a fixture model file. */
export interface FixtureInstance {
	name: string;
	children?: Array<FixtureInstance>;
	instanceClass: string;
	/** Serialized property elements beyond `Name`, written verbatim. */
	properties?: Array<string>;
}

export interface FixturePlaceOptions {
	/** Files written into the mounted directory, keyed by file name. */
	files: Record<string, string>;
	/** The service the package's rojo project mounts that directory under. */
	service: string;
}

/** The package name every fixture place stages under. */
export const FIXTURE_PACKAGE = "fixture";

/**
 * An `.rbxmx` holding `root`, in the shape a place round-trip writes out. The
 * class of a mounted instance lives in the file rather than in the project, so
 * a spec that wants rojo to decide it has nowhere else to put it.
 *
 * Referents are the child's path through the tree, which is unique without a
 * counter to thread through the walk.
 */
export function modelXml(root: FixtureInstance): string {
	return [
		'<roblox version="4">',
		...itemXml({ indent: "  ", node: root, referent: "0" }),
		"</roblox>",
	].join("\n");
}

/**
 * Build a place from a throwaway one-package project that mounts `files` under
 * one service, and report where it landed.
 *
 * A real `rojo build`, because that is the only thing that decides which
 * classes come out of a model file — the synthesizer sees the project, never
 * the file. The temp tree is removed when the test finishes.
 */
export async function buildFixturePlaceAsync({
	files,
	service,
}: FixturePlaceOptions): Promise<string> {
	const root = mkdtempSync(path.join(os.tmpdir(), "place-fixture-"));
	onTestFinished(() => {
		rmSync(root, { force: true, recursive: true });
	});

	const mount = `game-assets/${service}`;
	const assets = path.join(root, mount);
	mkdirSync(assets, { recursive: true });
	for (const [fileName, contents] of Object.entries(files)) {
		writeFileSync(path.join(assets, fileName), contents);
	}

	const rojoProjectPath = path.join(root, "test.project.json");
	writeFileSync(
		rojoProjectPath,
		JSON.stringify({
			name: FIXTURE_PACKAGE,
			tree: {
				$className: "DataModel",
				[service]: { $className: service, $path: mount },
			},
		}),
	);

	const placeFile = path.join(root, "out/place.rbxlx");
	await buildPlaceAsync({
		packages: [{ name: FIXTURE_PACKAGE, packageDirectory: root, rojoProjectPath }],
		placeFile,
		projectFile: path.join(root, "cache/synth.project.json"),
	});

	return placeFile;
}

function itemXml({
	indent,
	node,
	referent,
}: {
	indent: string;
	node: FixtureInstance;
	referent: string;
}): Array<string> {
	return [
		`${indent}<Item class="${node.instanceClass}" referent="${referent}">`,
		`${indent}\t<Properties>`,
		`${indent}\t\t<string name="Name">${node.name}</string>`,
		...(node.properties ?? []).map((property) => `${indent}\t\t${property}`),
		`${indent}\t</Properties>`,
		...(node.children ?? []).flatMap((child, index) => {
			return itemXml({
				indent: `${indent}\t`,
				node: child,
				referent: `${referent}-${index}`,
			});
		}),
		`${indent}</Item>`,
	];
}
