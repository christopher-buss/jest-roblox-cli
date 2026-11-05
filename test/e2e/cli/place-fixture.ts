import { buildRbxlx, synthesizeWorkspaceAsync } from "#test/e2e/cli/workspace-place.ts";

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
 * @param root - Root instance of the model.
 * @returns The `.rbxmx` document text.
 */
export function modelXml(root: FixtureInstance): string {
	return [
		'<roblox version="4">',
		...itemXml({ indent: "  ", node: root, referent: "0" }),
		"</roblox>",
	].join("\n");
}

/**
 * Build a place from a throwaway one-package workspace that mounts `files`
 * under one service, and report where it landed.
 *
 * The CLI synthesizes the place project, and a real `rojo build` turns it into
 * a place, because that is the only thing that decides which classes come out
 * of a model file: the synthesizer sees the project, never the file.
 * @param options - Files to mount and the service to mount them under.
 * @returns Path of the built place.
 */
export async function buildFixturePlaceAsync({
	files,
	service,
}: FixturePlaceOptions): Promise<string> {
	const mount = `game-assets/${service}`;
	const mounted = Object.entries(files).map(([fileName, contents]) => {
		return [`${mount}/${fileName}`, contents] as const;
	});
	const { projectPath } = await synthesizeWorkspaceAsync({
		packages: [
			{
				name: FIXTURE_PACKAGE,
				files: { ...Object.fromEntries(mounted), "tests/probe.spec.luau": "return {}\n" },
				tree: {
					ServerScriptService: {
						$className: "ServerScriptService",
						Tests: { $path: "tests" },
					},
					[service]: { $className: service, $path: mount },
				},
			},
		],
	});

	return buildRbxlx(projectPath);
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
