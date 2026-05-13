import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../config/schema.ts";
import { generateMaterializerScript, generateWorkStealingScript } from "./test-script-staged.ts";

describe(generateMaterializerScript, () => {
	it("should embed entry pkg and project in the substituted template", () => {
		expect.assertions(3);

		const script = generateMaterializerScript([
			{
				config: DEFAULT_CONFIG,
				pkg: "@halcyon/foo",
				project: "core",
				testFiles: ["src/foo.spec.ts"],
			},
		]);

		expect(script).toContain('"pkg":"@halcyon/foo"');
		expect(script).toContain('"project":"core"');
		expect(script).toContain("Jest.runCLI");
	});

	it("should preserve order across same-pkg multi-project entries", () => {
		expect.assertions(2);

		const script = generateMaterializerScript([
			{ config: DEFAULT_CONFIG, pkg: "@halcyon/foo", project: "core", testFiles: [] },
			{
				config: DEFAULT_CONFIG,
				pkg: "@halcyon/foo",
				project: "integration",
				testFiles: [],
			},
			{ config: DEFAULT_CONFIG, pkg: "@halcyon/foo", project: "e2e", testFiles: [] },
		]);

		const corePosition = script.indexOf('"project":"core"');
		const integrationPosition = script.indexOf('"project":"integration"');
		const e2ePosition = script.indexOf('"project":"e2e"');

		expect(corePosition).toBeLessThan(integrationPosition);
		expect(integrationPosition).toBeLessThan(e2ePosition);
	});

	it("should preserve order across multi-pkg multi-project entries", () => {
		expect.assertions(3);

		const script = generateMaterializerScript([
			{ config: DEFAULT_CONFIG, pkg: "@halcyon/foo", project: "alpha", testFiles: [] },
			{ config: DEFAULT_CONFIG, pkg: "@halcyon/bar", project: "beta", testFiles: [] },
			{ config: DEFAULT_CONFIG, pkg: "@halcyon/bar", project: "gamma", testFiles: [] },
		]);

		const fooPosition = script.indexOf('"pkg":"@halcyon/foo"');
		const firstBarPosition = script.indexOf('"pkg":"@halcyon/bar"');
		const lastBarPosition = script.lastIndexOf('"pkg":"@halcyon/bar"');

		expect(fooPosition).toBeGreaterThanOrEqual(0);
		expect(fooPosition).toBeLessThan(firstBarPosition);
		expect(lastBarPosition).toBeGreaterThan(firstBarPosition);
	});

	it("should wrap entries in an entries envelope", () => {
		expect.assertions(1);

		const script = generateMaterializerScript([
			{ config: DEFAULT_CONFIG, pkg: "@halcyon/foo", project: "core", testFiles: [] },
		]);

		expect(script).toContain('"entries":[');
	});

	it("should include the entry's testMatch in the substituted Jest argv", () => {
		expect.assertions(1);

		const script = generateMaterializerScript([
			{
				config: { ...DEFAULT_CONFIG, testMatch: ["**/*.spec.ts"] },
				pkg: "@halcyon/foo",
				project: "core",
				testFiles: ["src/foo.spec.ts"],
			},
		]);

		expect(script).toContain('"testMatch":["**/*.spec"]');
	});

	it("should include jestPath in the substituted Jest argv when set", () => {
		expect.assertions(1);

		const script = generateMaterializerScript([
			{
				config: {
					...DEFAULT_CONFIG,
					jestPath: "ReplicatedStorage/Packages/_Index/Jest",
				},
				pkg: "@halcyon/foo",
				project: "core",
				testFiles: [],
			},
		]);

		expect(script).toContain('"jestPath":"ReplicatedStorage/Packages/_Index/Jest"');
	});

	it("should embed payload inside a level-2 long-string", () => {
		expect.assertions(1);

		const script = generateMaterializerScript([
			{ config: DEFAULT_CONFIG, pkg: "@halcyon/foo", project: "core", testFiles: [] },
		]);

		expect(script).toContain("[==[");
	});

	it("should bundle the setup-paths resolver so Luau converts strings to Instances", () => {
		expect.assertions(2);

		const script = generateMaterializerScript([
			{
				config: {
					...DEFAULT_CONFIG,
					setupFilesAfterEnv: ["ReplicatedStorage/Pkg/Shared/setup"],
				},
				pkg: "@halcyon/foo",
				project: "core",
				testFiles: [],
			},
		]);

		// The generated Luau must invoke InstanceResolver on the setupFiles
		// arrays. Without this the materializer payload's DataModel-path
		// strings reach Jest unresolved and runCLI fails.
		expect(script).toContain("setupFilesAfterEnv");
		expect(script).toMatch(
			/InstanceResolver\.findInstance.*setup|resolveSetupPaths|entry\.config\.setupFiles/,
		);
	});

	it("should bundle the per-package coverage reset/capture logic into the materializer template", () => {
		expect.assertions(2);

		const script = generateMaterializerScript([
			{ config: DEFAULT_CONFIG, pkg: "@halcyon/foo", project: "core", testFiles: [] },
		]);

		// The bundled materializer must reset _G.__jest_roblox_cov between
		// packages and embed the captured map into the result envelope. The
		// rest of the runtime workflow lives in luau/staging/entry.luau but
		// must survive bundling; assert both halves are present.
		expect(script).toContain("__jest_roblox_cov");
		expect(script).toMatch(/_coverage/);
	});

	it("should throw when serialized payload contains the long-string terminator", () => {
		expect.assertions(1);

		expect(() => {
			return generateMaterializerScript([
				{
					config: { ...DEFAULT_CONFIG, jestPath: "boom]==]bad" },
					pkg: "@halcyon/foo",
					project: "core",
					testFiles: [],
				},
			]);
		}).toThrow(/]==]/);
	});
});

describe(generateWorkStealingScript, () => {
	it("should embed queueId and invisibilityWindowSeconds alongside the entries", () => {
		expect.assertions(3);

		const script = generateWorkStealingScript(
			[
				{
					config: DEFAULT_CONFIG,
					pkg: "@halcyon/foo",
					project: "core",
					testFiles: ["src/foo.spec.ts"],
				},
			],
			"queue-uuid-1",
			90,
		);

		expect(script).toContain('"queueId":"queue-uuid-1"');
		expect(script).toContain('"invisibilityWindowSeconds":90');
		expect(script).toContain('"pkg":"@halcyon/foo"');
	});

	it("should preserve entries in input order", () => {
		expect.assertions(1);

		const script = generateWorkStealingScript(
			[
				{ config: DEFAULT_CONFIG, pkg: "@halcyon/foo", project: "alpha", testFiles: [] },
				{ config: DEFAULT_CONFIG, pkg: "@halcyon/bar", project: "beta", testFiles: [] },
			],
			"queue-uuid-2",
			60,
		);

		expect(script.indexOf('"pkg":"@halcyon/foo"')).toBeLessThan(
			script.indexOf('"pkg":"@halcyon/bar"'),
		);
	});

	it("should reject queueIds containing the long-string terminator", () => {
		expect.assertions(1);

		expect(() => {
			return generateWorkStealingScript(
				[{ config: DEFAULT_CONFIG, pkg: "@halcyon/foo", project: "core", testFiles: [] }],
				"queue]==]bad",
				60,
			);
		}).toThrow(/]==]/);
	});

	it("should embed sortedMapId and streamingTtlSeconds when streaming is configured", () => {
		expect.assertions(2);

		const script = generateWorkStealingScript(
			[{ config: DEFAULT_CONFIG, pkg: "@halcyon/foo", project: "core", testFiles: [] }],
			"queue-uuid-1",
			90,
			{ streaming: { sortedMapId: "stream-uuid", ttlSeconds: 300 } },
		);

		expect(script).toContain('"sortedMapId":"stream-uuid"');
		expect(script).toContain('"streamingTtlSeconds":300');
	});

	it("should omit streaming payload fields when streaming is not configured", () => {
		expect.assertions(2);

		const script = generateWorkStealingScript(
			[{ config: DEFAULT_CONFIG, pkg: "@halcyon/foo", project: "core", testFiles: [] }],
			"queue-uuid-1",
			90,
		);

		// The Luau template always references `sortedMapId` in its type
		// declaration; assert the JSON payload does not embed a value for it.
		expect(script).not.toContain('"sortedMapId":');
		expect(script).not.toContain('"streamingTtlSeconds":');
	});
});

describe("generateMaterializerScript with streaming", () => {
	it("should embed sortedMapId when streaming is configured", () => {
		expect.assertions(1);

		const script = generateMaterializerScript(
			[{ config: DEFAULT_CONFIG, pkg: "@halcyon/foo", project: "core", testFiles: [] }],
			{ streaming: { sortedMapId: "stream-uuid" } },
		);

		expect(script).toContain('"sortedMapId":"stream-uuid"');
	});
});
