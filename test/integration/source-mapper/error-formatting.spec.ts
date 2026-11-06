import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { formatFailure } from "#src/index.ts";
import { createFixtureSandbox } from "#test/e2e/cli/helpers.ts";
import {
	buildProjectSourceMapperAsync,
	type SourceMapper,
} from "#test/integration/source-mapper/project-source-mapper.ts";
import { posixPath } from "#test/mocks/posix-path.ts";

const FIXTURE_DIR = path.resolve(__dirname, "../../fixtures");
const LUAU_OUT_DIRECTORY = /(?<![\w/])out\//g;

const DATA_MODEL_PATH = "ReplicatedStorage.player.spec";

let rootDirectory = "";

async function createFixtureSourceMapperAsync(): Promise<SourceMapper> {
	const sandbox = createFixtureSandbox(FIXTURE_DIR);
	writeFileSync(
		path.join(sandbox, "tsconfig.json"),
		JSON.stringify({ compilerOptions: { outDir: "out", rootDir: "src" } }),
	);
	rootDirectory = posixPath(path.join(sandbox, "src"));
	return buildProjectSourceMapperAsync(sandbox);
}

function normalizePaths(output: string): string {
	return output
		.replaceAll(rootDirectory, "<ROOT_DIRECTORY>")
		.replace(LUAU_OUT_DIRECTORY, "<OUT_DIRECTORY>/");
}

function stack(luauLine: number): string {
	return `expect(received).toBe(expected)\n\nExpected: 100\nReceived: 0\n[string "${DATA_MODEL_PATH}"]:${luauLine}`;
}

function snapshotStack(luauLine: number): string {
	return [
		"expect(received).toMatchSnapshot()",
		"",
		"Snapshot name: `Player should match snapshot 1`",
		"",
		"- Snapshot  - 1",
		"+ Received  + 1",
		"",
		"  Object {",
		'    "name": "Dave",',
		'-   "health": 100,',
		'+   "health": 150,',
		"  }",
		"",
		`[string "${DATA_MODEL_PATH}"]:${luauLine}`,
	].join("\n");
}

describe("source-mapper pipeline", () => {
	it("should map simple expect().toBe() to exact TS line", async () => {
		expect.assertions(3);

		const sourceMapper = await createFixtureSourceMapperAsync();

		const { locations } = sourceMapper.mapFailureWithLocations(stack(15));

		expect(locations[0]!.luauLine).toBe(15);
		expect(locations[0]!.tsLine).toBe(6);
		expect(locations[0]!.tsColumn).toBe(23);
	});

	it("should map .never.toBe() with column on toBe not never", async () => {
		expect.assertions(3);

		const sourceMapper = await createFixtureSourceMapperAsync();

		const { locations } = sourceMapper.mapFailureWithLocations(stack(20));

		expect(locations[0]!.luauLine).toBe(20);
		expect(locations[0]!.tsLine).toBe(11);
		expect(locations[0]!.tsColumn).toBe(24);
	});

	it("should map expect() inside closure despite function()/arrow offset", async () => {
		expect.assertions(3);

		const sourceMapper = await createFixtureSourceMapperAsync();

		const { locations } = sourceMapper.mapFailureWithLocations(stack(28));

		expect(locations[0]!.luauLine).toBe(28);
		expect(locations[0]!.tsLine).toBe(18);
		expect(locations[0]!.tsColumn).toBe(18);
	});

	it("should map optional chaining temp vars via pattern match", async () => {
		expect.assertions(3);

		const sourceMapper = await createFixtureSourceMapperAsync();

		const { locations } = sourceMapper.mapFailureWithLocations(stack(36));

		expect(locations[0]!.luauLine).toBe(36);
		expect(locations[0]!.tsLine).toBe(24);
		expect(locations[0]!.tsColumn).toBe(32);
	});

	it("should map .toMatchSnapshot() to exact TS line", async () => {
		expect.assertions(3);

		const sourceMapper = await createFixtureSourceMapperAsync();

		const { locations } = sourceMapper.mapFailureWithLocations(stack(41));

		expect(locations[0]!.luauLine).toBe(41);
		expect(locations[0]!.tsLine).toBe(29);
		expect(locations[0]!.tsColumn).toBe(18);
	});
});

describe("formatter output", () => {
	it("should render TS snippet for simple assertion", async () => {
		expect.assertions(1);

		const sourceMapper = await createFixtureSourceMapperAsync();

		const output = formatFailure({
			sourceMapper,
			test: {
				ancestorTitles: ["Player"],
				duration: 5,
				failureMessages: [stack(15)],
				fullName: "Player should have correct name",
				status: "failed",
				title: "should have correct name",
			},
			useColor: false,
		});

		expect(normalizePaths(output)).toMatchInlineSnapshot(`
			"  
			   FAIL  Player > should have correct name
			  expect(received).toBe(expected)
			  
			  - Expected
			  + Received
			  
			  - 100
			  + 0
			  
			   ❯ <ROOT_DIRECTORY>/shared/player.spec.ts:6:23
				4|     it("should have correct name", () => {
				5|         const player = createPlayer("Alice");
				6|         expect(player.name).toBe("Alice");
				 |                             ^
				7|     });
				8| "
		`);
	});

	it("should render TS+Luau snippets when showLuau is true", async () => {
		expect.assertions(1);

		const sourceMapper = await createFixtureSourceMapperAsync();

		const output = formatFailure({
			showLuau: true,
			sourceMapper,
			test: {
				ancestorTitles: ["Player"],
				duration: 5,
				failureMessages: [stack(15)],
				fullName: "Player should have correct name",
				status: "failed",
				title: "should have correct name",
			},
			useColor: false,
		});

		expect(normalizePaths(output)).toMatchInlineSnapshot(`
			"  
			   FAIL  Player > should have correct name
			  expect(received).toBe(expected)
			  
			  - Expected
			  + Received
			  
			  - 100
			  + 0
			  
			   ❯ <ROOT_DIRECTORY>/shared/player.spec.ts:6:23  (TypeScript)
				4|     it("should have correct name", () => {
				5|         const player = createPlayer("Alice");
				6|         expect(player.name).toBe("Alice");
				 |                             ^
				7|     });
				8| 
			  
			   ❯ <OUT_DIRECTORY>/shared/player.spec.luau:15:22  (Luau)
				13|         expect(player.name):toBe("Alice")
				14|     end)
				15|     expect(player.name):toBe("Alice")
				  |                         ^
				16|     it("should never be zero", function()
				17|         local health = 100"
		`);
	});

	it("should render .never.toBe() mapping", async () => {
		expect.assertions(1);

		const sourceMapper = await createFixtureSourceMapperAsync();

		const output = formatFailure({
			sourceMapper,
			test: {
				ancestorTitles: ["Player"],
				duration: 5,
				failureMessages: [stack(20)],
				fullName: "Player should never be zero",
				status: "failed",
				title: "should never be zero",
			},
			useColor: false,
		});

		expect(normalizePaths(output)).toMatchInlineSnapshot(`
			"  
			   FAIL  Player > should never be zero
			  expect(received).toBe(expected)
			  
			  - Expected
			  + Received
			  
			  - 100
			  + 0
			  
			   ❯ <ROOT_DIRECTORY>/shared/player.spec.ts:11:24
				 9|     it("should never be zero", () => {
				10|         const health = 100;
				11|         expect(health).never.toBe(0);
				  |                              ^
				12|     });
				13| "
		`);
	});

	it("should render closure expect mapping", async () => {
		expect.assertions(1);

		const sourceMapper = await createFixtureSourceMapperAsync();

		const output = formatFailure({
			sourceMapper,
			test: {
				ancestorTitles: ["Player"],
				duration: 5,
				failureMessages: [stack(28)],
				fullName: "Player should track scores",
				status: "failed",
				title: "should track scores",
			},
			useColor: false,
		});

		expect(normalizePaths(output)).toMatchInlineSnapshot(`
			"  
			   FAIL  Player > should track scores
			  expect(received).toBe(expected)
			  
			  - Expected
			  + Received
			  
			  - 100
			  + 0
			  
			   ❯ <ROOT_DIRECTORY>/shared/player.spec.ts:18:18
				16|         [10, 20].forEach((score) => {
				17|             scores.push(score);
				18|             expect(score).toBeGreaterThan(0);
				  |                           ^
				19|         });
				20|     });"
		`);
	});

	it("should render toMatchSnapshot() mapping", async () => {
		expect.assertions(1);

		const sourceMapper = await createFixtureSourceMapperAsync();

		const output = formatFailure({
			sourceMapper,
			test: {
				ancestorTitles: ["Player"],
				duration: 5,
				failureMessages: [stack(41)],
				fullName: "Player should match snapshot",
				status: "failed",
				title: "should match snapshot",
			},
			useColor: false,
		});

		expect(normalizePaths(output)).toMatchInlineSnapshot(`
			"  
			   FAIL  Player > should match snapshot
			  expect(received).toBe(expected)
			  
			  - Expected
			  + Received
			  
			  - 100
			  + 0
			  
			   ❯ <ROOT_DIRECTORY>/shared/player.spec.ts:29:18
				27|     it("should match snapshot", () => {
				28|         const player = createPlayer("Dave");
				29|         expect(player).toMatchSnapshot();
				  |                        ^
				30|     });
				31| });"
		`);
	});

	it("should render snapshot diff without swallowing mapped TS location", async () => {
		expect.assertions(1);

		const sourceMapper = await createFixtureSourceMapperAsync();

		const output = formatFailure({
			sourceMapper,
			test: {
				ancestorTitles: ["Player"],
				duration: 5,
				failureMessages: [snapshotStack(41)],
				fullName: "Player should match snapshot",
				status: "failed",
				title: "should match snapshot",
			},
			useColor: false,
		});

		expect(normalizePaths(output)).toMatchInlineSnapshot(`
			"  
			   FAIL  Player > should match snapshot
			  expect(received).toMatchSnapshot()
			  
			  - Snapshot  - 1
			  + Received  + 1
			  
			    Object {
			      "name": "Dave",
			  -   "health": 100,
			  +   "health": 150,
			    }
			  
			   ❯ <ROOT_DIRECTORY>/shared/player.spec.ts:29:18
				27|     it("should match snapshot", () => {
				28|         const player = createPlayer("Dave");
				29|         expect(player).toMatchSnapshot();
				  |                        ^
				30|     });
				31| });"
		`);
	});

	it("should render optional chaining mapping", async () => {
		expect.assertions(1);

		const sourceMapper = await createFixtureSourceMapperAsync();

		const output = formatFailure({
			sourceMapper,
			test: {
				ancestorTitles: ["Player"],
				duration: 5,
				failureMessages: [stack(36)],
				fullName: "Player should read optional stats",
				status: "failed",
				title: "should read optional stats",
			},
			useColor: false,
		});

		expect(normalizePaths(output)).toMatchInlineSnapshot(`
			"  
			   FAIL  Player > should read optional stats
			  expect(received).toBe(expected)
			  
			  - Expected
			  + Received
			  
			  - 100
			  + 0
			  
			   ❯ <ROOT_DIRECTORY>/shared/player.spec.ts:24:32
				22|     it("should read optional stats", () => {
				23|         const player = createPlayer("Charlie");
				24|         expect(player.stats?.health).toBe(100);
				  |                                      ^
				25|     });
				26| "
		`);
	});
});
