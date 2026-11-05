import { describe, expect, it } from "vitest";

import { configErrorLike } from "#test/mocks/run-config-error.ts";
import type { RojoTreeNode } from "../types/rojo.ts";
import type { HoistedService, PackageHoist } from "./service-hoist.ts";
import { applyHoistedServices, isSameValue, mergeHoistedServices } from "./service-hoist.ts";

function service(
	names: Array<[string, string]>,
	properties: HoistedService["properties"],
): HoistedService {
	return {
		properties,
		segments: names.map(([name, serviceClass]) => ({ name, serviceClass })),
	};
}

function hoist(packageName: string, ...services: Array<HoistedService>): PackageHoist {
	return { packageName, services };
}

describe(mergeHoistedServices, () => {
	it("should merge agreeing properties from different packages", () => {
		expect.assertions(1);

		const merged = mergeHoistedServices([
			hoist("@halcyon/foo", service([["Workspace", "Workspace"]], { Gravity: 10 })),
			hoist(
				"@halcyon/bar",
				service([["Workspace", "Workspace"]], { Gravity: 10, StreamingEnabled: true }),
			),
		]);

		expect(merged).toStrictEqual([
			service([["Workspace", "Workspace"]], { Gravity: 10, StreamingEnabled: true }),
		]);
	});

	it("should keep the first class when packages alias one hoisted path differently", () => {
		expect.assertions(1);

		const merged = mergeHoistedServices([
			hoist("@halcyon/foo", service([["Shared", "Workspace"]], { Name: "shared" })),
			hoist("@halcyon/bar", service([["Shared", "Terrain"]], { Name: "shared" })),
		]);

		expect(merged).toStrictEqual([service([["Shared", "Workspace"]], { Name: "shared" })]);
	});

	it("should keep distinct service paths whose segments concatenate alike", () => {
		expect.assertions(1);

		const merged = mergeHoistedServices([
			hoist(
				"@halcyon/foo",
				service(
					[
						["A", "A"],
						["BC", "Terrain"],
					],
					{ Name: "first" },
				),
				service(
					[
						["AB", "AB"],
						["C", "Terrain"],
					],
					{ Name: "second" },
				),
			),
		]);

		expect(merged).toHaveLength(2);
	});

	it("should throw ConfigError when packages disagree on a hoisted property", () => {
		expect.assertions(1);

		expect(() => {
			mergeHoistedServices([
				hoist(
					"@halcyon/foo",
					service([["Workspace", "Workspace"]], { StreamingEnabled: true }),
				),
				hoist(
					"@halcyon/bar",
					service([["Workspace", "Workspace"]], { StreamingEnabled: false }),
				),
			]);
		}).toThrow(
			configErrorLike(
				"workspace packages disagree on `Workspace.StreamingEnabled`.\n\n" +
					"  - true — declared by @halcyon/foo\n" +
					"  - false — declared by @halcyon/bar\n\n" +
					"Every package in a workspace run shares one synthesized place, so a\n" +
					"service property is a property of the whole run. Either align the value\n" +
					"across each package's rojo project, or run the odd package on its own.",
			),
		);
	});

	it("should label a root property conflict against DataModel", () => {
		expect.assertions(1);

		expect(() => {
			mergeHoistedServices([
				hoist("@halcyon/foo", service([], { Name: "foo" })),
				hoist("@halcyon/bar", service([], { Name: "bar" })),
			]);
		}).toThrow(/disagree on `DataModel\.Name`/);
	});
});

describe(applyHoistedServices, () => {
	it("should create each service node on the way down", () => {
		expect.assertions(1);

		const tree: RojoTreeNode = { $className: "DataModel" };

		applyHoistedServices(tree, [
			service(
				[
					["StarterPlayer", "StarterPlayer"],
					["StarterPlayerScripts", "StarterPlayerScripts"],
				],
				{ Name: "scripts" },
			),
		]);

		expect(tree).toStrictEqual({
			$className: "DataModel",
			StarterPlayer: {
				$className: "StarterPlayer",
				StarterPlayerScripts: {
					$className: "StarterPlayerScripts",
					$properties: { Name: "scripts" },
				},
			},
		});
	});

	it("should keep an existing node and its class", () => {
		expect.assertions(1);

		const tree: RojoTreeNode = {
			ServerStorage: { $className: "ServerStorage", __pkg_stage: { $className: "Folder" } },
		};

		applyHoistedServices(tree, [service([["ServerStorage", "Other"]], { Name: "kept" })]);

		expect(tree).toStrictEqual({
			ServerStorage: {
				$className: "ServerStorage",
				$properties: { Name: "kept" },
				__pkg_stage: { $className: "Folder" },
			},
		});
	});

	it("should write root properties onto the place itself", () => {
		expect.assertions(1);

		const tree: RojoTreeNode = { $className: "DataModel" };

		applyHoistedServices(tree, [service([], { Name: "place" })]);

		expect(tree.$properties).toStrictEqual({ Name: "place" });
	});
});

describe(isSameValue, () => {
	it("should compare JSON values structurally", () => {
		expect.assertions(2);

		expect(isSameValue(["a", 1], ["a", 1])).toBeTrue();
		expect(isSameValue({ a: 1 }, { a: 2 })).toBeFalse();
	});
});
