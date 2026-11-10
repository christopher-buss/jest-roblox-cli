// cspell:words includ
import type { PathKind, RojoTreeNode } from "@isentinel/rojo-utils";
import { fromAny } from "@total-typescript/shoehorn";

import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import { createProjectSeams } from "#test/mocks/spec-project-seams.ts";
import type { ProjectTestConfig } from "./config-types.ts";
import type { ResolvedProjectConfig } from "./projects.ts";
import { extractStaticRoot, resolveAllProjects } from "./projects.ts";
import type { ResolvedConfig } from "./resolved-config.ts";

const CWD = "/project";

const SRC_HINT =
	'Path starts with "src/" — if using roblox-ts, set "outDir" in your project config to the compiled output directory (e.g. "out/client")';

type MountKinds = Record<string, PathKind>;

function mountKinds(kinds: MountKinds): MountKinds {
	return kinds;
}

function treePaths(node: unknown): Array<string> {
	if (typeof node !== "object" || node === null) {
		return [];
	}

	return Object.entries(node).flatMap(([key, value]: [string, unknown]) => {
		if (key === "$path") {
			return [
				typeof value === "string"
					? value
					: fromAny<{ optional: string }, unknown>(value).optional,
			];
		}

		return key.startsWith("$") ? [] : treePaths(value);
	});
}

function seedFor(kinds: MountKinds): Record<string, string> {
	return Object.fromEntries(
		Object.entries(kinds).flatMap(([fsPath, kind]) => {
			if (kind === "missing") {
				return [];
			}

			const target = path.posix.join(CWD, fsPath);
			return [[kind === "directory" ? `${target}/.keep` : target, ""]];
		}),
	);
}

async function resolveProjects({
	kinds,
	projects,
	rojoTree,
	rootConfig,
}: {
	kinds?: MountKinds;
	projects: Array<ProjectTestConfig>;
	rojoTree: RojoTreeNode;
	rootConfig: ResolvedConfig;
}): Promise<Array<ResolvedProjectConfig>> {
	const directories =
		kinds ??
		Object.fromEntries(treePaths(rojoTree).map((fsPath) => [fsPath, "directory" as const]));
	const { fileSystem } = createMemoryFileSystem(seedFor(directories), CWD);

	return resolveAllProjects({
		cwd: CWD,
		entries: projects.map((test) => ({ test })),
		fileSystem,
		rojoTree,
		rootConfig,
	});
}

async function resolveProject({
	project,
	...rest
}: {
	kinds?: MountKinds;
	project: ProjectTestConfig;
	rojoTree: RojoTreeNode;
	rootConfig: ResolvedConfig;
}): Promise<ResolvedProjectConfig> {
	const [resolved] = await resolveProjects({ ...rest, projects: [project] });
	return resolved!;
}

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (err) {
		return err;
	}

	throw new Error("expected a rejection");
}

const simpleRojoTree: RojoTreeNode = {
	$className: "DataModel",
	ReplicatedStorage: {
		client: { $path: "out/client" },
	},
	ServerScriptService: {
		server: { $path: "out/server" },
	},
};

function makeProject(overrides: Partial<ProjectTestConfig> = {}): ProjectTestConfig {
	return {
		displayName: "test-project",
		include: ["src/client/**/*.spec.ts"],
		...overrides,
	};
}

describe(extractStaticRoot, () => {
	it("should split at first glob character *", () => {
		expect.assertions(2);

		const result = extractStaticRoot("src/client/**/*.spec.ts");

		expect(result.root).toBe("src/client");
		expect(result.glob).toBe("**/*.spec.ts");
	});

	it("should split at first glob character ?", () => {
		expect.assertions(2);

		const result = extractStaticRoot("src/client/foo?.spec.ts");

		expect(result.root).toBe("src/client");
		expect(result.glob).toBe("foo?.spec.ts");
	});

	it("should split at first glob character {", () => {
		expect.assertions(2);

		const result = extractStaticRoot("src/{a,b}/*.spec.ts");

		expect(result.root).toBe("src");
		expect(result.glob).toBe("{a,b}/*.spec.ts");
	});

	it("should split at first glob character [", () => {
		expect.assertions(2);

		const result = extractStaticRoot("src/[abc]/*.spec.ts");

		expect(result.root).toBe("src");
		expect(result.glob).toBe("[abc]/*.spec.ts");
	});

	it("should throw when pattern has no static directory prefix", () => {
		expect.assertions(1);

		expect(() => extractStaticRoot("**/*.spec.ts")).toThrow(
			"Include pattern must have a static directory prefix",
		);
	});

	it("should throw when glob starts immediately with no slash", () => {
		expect.assertions(1);

		expect(() => extractStaticRoot("*.spec.ts")).toThrow(
			"Include pattern must have a static directory prefix",
		);
	});

	it("should handle pattern with no glob characters", () => {
		expect.assertions(2);

		const result = extractStaticRoot("src/client/foo.spec.ts");

		expect(result.root).toBe("src/client");
		expect(result.glob).toBe("foo.spec.ts");
	});

	it("should handle a filename-only pattern with no glob characters", () => {
		expect.assertions(1);

		expect(extractStaticRoot("foo.spec.ts")).toStrictEqual({
			glob: "foo.spec.ts",
			root: ".",
		});
	});
});

describe("include roots", () => {
	const rootConfig = createResolvedConfig();

	function rootsTree(...fsPaths: Array<string>): RojoTreeNode {
		return {
			$className: "DataModel",
			...Object.fromEntries(
				fsPaths.map((fsPath, index) => [`Root${index}`, { $path: fsPath }]),
			),
		};
	}

	async function resolveInclude(include: Array<string>, ...fsPaths: Array<string>) {
		return resolveProject({
			project: makeProject({ include }),
			rojoTree: rootsTree(...fsPaths),
			rootConfig,
		});
	}

	it.for([
		["**/*.spec.ts", "**/*.spec"],
		["**/*.test.tsx", "**/*.test"],
		["**/*.spec.lua", "**/*.spec"],
		["**/*.spec.luau", "**/*.spec"],
		["**/*.spec", "**/*.spec"],
		["**/*.spec.js", "**/*.spec.js"],
	] as const)("should derive testMatch %s as %s", async ([glob, testMatch]) => {
		expect.assertions(1);

		const result = await resolveInclude([`src/${glob}`], "src");

		expect(result.testMatch).toStrictEqual([testMatch]);
	});

	it("should extract single root with single pattern", async () => {
		expect.assertions(2);

		const result = await resolveInclude(["src/client/**/*.spec.ts"], "src/client");

		expect(result.testMatch).toStrictEqual(["**/*.spec"]);
		expect(result.rojoMounts).toStrictEqual([{ dataModelPath: "Root0", fsPath: "src/client" }]);
	});

	it("should group multiple patterns under same root", async () => {
		expect.assertions(2);

		const result = await resolveInclude(
			["src/client/**/*.spec.ts", "src/client/**/*.test.ts"],
			"src/client",
		);

		expect(result.testMatch).toStrictEqual(["**/*.spec", "**/*.test"]);
		expect(result.rojoMounts).toStrictEqual([{ dataModelPath: "Root0", fsPath: "src/client" }]);
	});

	it("should separate different roots", async () => {
		expect.assertions(2);

		const result = await resolveInclude(
			["src/client/**/*.spec.ts", "src/server/**/*.spec.ts"],
			"src/client",
			"src/server",
		);

		expect(result.testMatch).toStrictEqual(["**/*.spec"]);
		expect(result.rojoMounts).toStrictEqual([
			{ dataModelPath: "Root0", fsPath: "src/client" },
			{ dataModelPath: "Root1", fsPath: "src/server" },
		]);
	});

	it("should prepend **/ to testMatch without path separator", async () => {
		expect.assertions(1);

		const result = await resolveInclude(["src/*.spec.ts"], "src");

		expect(result.testMatch).toStrictEqual(["**/*.spec"]);
	});

	it("should not prepend **/ to testMatch with path separator", async () => {
		expect.assertions(1);

		const result = await resolveInclude(["src/**/*.spec.ts"], "src");

		expect(result.testMatch).toStrictEqual(["**/*.spec"]);
	});

	it("should handle mixed roots and patterns", async () => {
		expect.assertions(2);

		const result = await resolveInclude(
			["src/client/**/*.spec.ts", "src/client/**/*.test.tsx", "src/server/**/*.spec.ts"],
			"src/client",
			"src/server",
		);

		expect(result.testMatch).toStrictEqual(["**/*.spec", "**/*.test"]);
		expect(result.rojoMounts).toStrictEqual([
			{ dataModelPath: "Root0", fsPath: "src/client" },
			{ dataModelPath: "Root1", fsPath: "src/server" },
		]);
	});
});

describe("project validation", () => {
	const rootConfig = createResolvedConfig();

	async function validate(projects: Array<ProjectTestConfig>) {
		return resolveProjects({ projects, rojoTree: simpleRojoTree, rootConfig });
	}

	function mappable(overrides: Partial<ProjectTestConfig>): ProjectTestConfig {
		return makeProject({ outDir: "out/client", ...overrides });
	}

	it("should accept valid projects", async () => {
		expect.assertions(1);

		await expect(
			validate([mappable({ displayName: "client" }), mappable({ displayName: "server" })]),
		).resolves.toHaveLength(2);
	});

	it("should throw on empty displayName string", async () => {
		expect.assertions(1);

		await expect(validate([mappable({ displayName: "" })])).rejects.toThrow(
			"Project must have a non-empty displayName",
		);
	});

	it("should throw on empty displayName object", async () => {
		expect.assertions(1);

		await expect(
			validate([mappable({ displayName: { name: "", color: "blue" } })]),
		).rejects.toThrow("Project must have a non-empty displayName");
	});

	it("should throw on duplicate displayName", async () => {
		expect.assertions(1);

		await expect(
			validate([mappable({ displayName: "client" }), mappable({ displayName: "client" })]),
		).rejects.toThrow("Duplicate project displayName: client");
	});

	it("should throw on empty include array", async () => {
		expect.assertions(1);

		await expect(validate([mappable({ displayName: "client", include: [] })])).rejects.toThrow(
			'Project "client" must have at least one include pattern',
		);
	});

	it("should throw when include was never derived", async () => {
		expect.assertions(1);

		await expect(validate([fromAny({ displayName: "client" })])).rejects.toThrow(
			'Project "client" must have at least one include pattern',
		);
	});
});

describe("project resolution", () => {
	const rootConfig: ResolvedConfig = {
		...createResolvedConfig(),
		rootDir: "/project",
		silent: false,
		verbose: true,
	};

	async function resolveCoreClient(
		overrides: Partial<ProjectTestConfig> = {},
	): Promise<ResolvedProjectConfig> {
		return resolveProject({
			project: makeProject({
				displayName: "client",
				include: ["src/client/**/*.spec.ts"],
				outDir: "out/client",
				root: "packages/core",
				...overrides,
			}),
			rojoTree: {
				$className: "DataModel",
				ReplicatedStorage: {
					client: { $path: "packages/core/out/client" },
				},
			},
			rootConfig,
		});
	}

	it("should resolve DataModel path from outDir", async () => {
		expect.assertions(1);

		const project = makeProject({
			displayName: "client",
			include: ["src/client/**/*.spec.ts"],
			outDir: "out/client",
		});

		const result = await resolveProject({
			project,
			rojoTree: simpleRojoTree,
			rootConfig,
		});

		expect(result.projects).toStrictEqual(["ReplicatedStorage/client"]);
	});

	it("should fall back to static root from include when outDir is not set", async () => {
		expect.assertions(1);

		const tree: RojoTreeNode = {
			$className: "DataModel",
			ReplicatedStorage: {
				shared: { $path: "src/shared" },
			},
		};

		const project = makeProject({
			displayName: "shared",
			include: ["src/shared/**/*.spec.luau"],
		});

		const result = await resolveProject({
			project,
			rojoTree: tree,
			rootConfig,
		});

		expect(result.projects).toStrictEqual(["ReplicatedStorage/shared"]);
	});

	it("should combine root and outDir for DataModel lookup", async () => {
		expect.assertions(1);

		const result = await resolveCoreClient();

		expect(result.projects).toStrictEqual(["ReplicatedStorage/client"]);
	});

	it("should store resolved outDir on result", async () => {
		expect.assertions(1);

		const project = makeProject({
			displayName: "client",
			include: ["src/client/**/*.spec.ts"],
			outDir: "out/client",
		});

		const result = await resolveProject({
			project,
			rojoTree: simpleRojoTree,
			rootConfig,
		});

		expect(result.outDir).toBe("out/client");
	});

	it("should store resolved outDir with root prefix", async () => {
		expect.assertions(1);

		const result = await resolveCoreClient();

		expect(result.outDir).toBe("packages/core/out/client");
	});

	it("should extract testMatch from include patterns with stripped extensions", async () => {
		expect.assertions(1);

		const project = makeProject({
			displayName: "client",
			include: ["src/client/**/*.spec.ts", "src/client/**/*.test.tsx"],
			outDir: "out/client",
		});

		const result = await resolveProject({
			project,
			rojoTree: simpleRojoTree,
			rootConfig,
		});

		expect(result.testMatch).toStrictEqual(["**/*.spec", "**/*.test"]);
	});

	it("should inherit non-ROOT_ONLY fields from root config", async () => {
		expect.assertions(2);

		const project = makeProject({ displayName: "client", outDir: "out/client" });

		const result = await resolveProject({
			project,
			rojoTree: simpleRojoTree,
			rootConfig,
		});

		expect(result.config.verbose).toBeTrue();
		expect(result.config.silent).toBeFalse();
	});

	it("should keep ROOT_ONLY keys from root config", async () => {
		expect.assertions(2);

		const project = makeProject({ displayName: "client", outDir: "out/client" });

		const result = await resolveProject({
			project,
			rojoTree: simpleRojoTree,
			rootConfig,
		});

		expect(result.config.backend).toBe(rootConfig.backend);
		expect(result.config.rootDir).toBe(rootConfig.rootDir);
	});

	it("should allow project to override non-ROOT_ONLY fields", async () => {
		expect.assertions(1);

		const project = makeProject({
			displayName: "client",
			outDir: "out/client",
			testTimeout: 5000,
		});

		const result = await resolveProject({
			project,
			rojoTree: simpleRojoTree,
			rootConfig,
		});

		expect(result.config.testTimeout).toBe(5000);
	});

	it("should keep every project-structural field out of the runtime config", async () => {
		expect.assertions(1);

		const project = makeProject({
			displayName: "client",
			exclude: ["src/client/generated/**"],
			include: ["src/client/**/*.spec.ts"],
			outDir: "out/client",
			root: ".",
			typecheck: { enabled: true },
		});

		const result = await resolveProject({
			project,
			rojoTree: simpleRojoTree,
			rootConfig,
		});

		expect({
			displayName: Reflect.get(result.config, "displayName"),
			exclude: Reflect.get(result.config, "exclude"),
			include: Reflect.get(result.config, "include"),
			outDir: Reflect.get(result.config, "outDir"),
			root: Reflect.get(result.config, "root"),
			typecheck: Reflect.get(result.config, "typecheck"),
		}).toStrictEqual({
			displayName: undefined,
			exclude: undefined,
			include: undefined,
			outDir: undefined,
			root: undefined,
			typecheck: undefined,
		});
	});

	it("should skip undefined project override values", async () => {
		expect.assertions(1);

		// `testTimeout: undefined` cannot be expressed under
		// exactOptionalPropertyTypes, but a hand-written config can still
		// deliver it at runtime — which is the path under test.
		const project: ProjectTestConfig = fromAny({
			...makeProject({ displayName: "client", outDir: "out/client" }),
			testTimeout: undefined,
		});

		const result = await resolveProject({
			project,
			rojoTree: simpleRojoTree,
			rootConfig: { ...rootConfig, testTimeout: 12_345 },
		});

		expect(result.config.testTimeout).toBe(12_345);
	});

	it("should extract displayName string from DisplayName object", async () => {
		expect.assertions(1);

		const project = makeProject({
			displayName: { name: "client-tests", color: "cyan" },
			outDir: "out/client",
		});

		const result = await resolveProject({
			project,
			rojoTree: simpleRojoTree,
			rootConfig,
		});

		expect(result.displayName).toBe("client-tests");
	});

	it("should prepend root to resolved include patterns for filesystem discovery", async () => {
		expect.assertions(1);

		const result = await resolveCoreClient();

		expect(result.include).toStrictEqual(["packages/core/src/client/**/*.spec.ts"]);
	});

	it("should prepend root to resolved exclude patterns for filesystem discovery", async () => {
		expect.assertions(1);

		const result = await resolveCoreClient({ exclude: ["src/client/**/*.gen.spec.ts"] });

		expect(result.exclude).toStrictEqual(["packages/core/src/client/**/*.gen.spec.ts"]);
	});

	it("should populate rojoMounts with a single mount when outDir is set", async () => {
		expect.assertions(2);

		const project = makeProject({
			displayName: "client",
			include: ["src/client/**/*.spec.ts"],
			outDir: "out/client",
		});

		const result = await resolveProject({
			project,
			rojoTree: simpleRojoTree,
			rootConfig,
		});

		expect(result.rojoMounts).toStrictEqual([
			{ dataModelPath: "ReplicatedStorage/client", fsPath: "out/client" },
		]);
		expect(result.outDir).toBe("out/client");
	});

	it("should auto-expand multi-root includes via tree walk", async () => {
		expect.assertions(4);

		const tree = {
			$className: "DataModel",
			ReplicatedStorage: {
				Client: { $path: "src/Client" },
				Shared: { $path: "src/Shared" },
			},
			ServerScriptService: {
				Server: { $path: "src/Server" },
			},
		} satisfies RojoTreeNode;

		const project = makeProject({
			displayName: "friends",
			include: ["src/**/*.spec.luau"],
		});

		const result = await resolveProject({
			project,
			rojoTree: tree,
			rootConfig,
		});

		expect(result.projects).toStrictEqual([
			"ReplicatedStorage/Client",
			"ReplicatedStorage/Shared",
			"ServerScriptService/Server",
		]);
		expect(result.rojoMounts).toStrictEqual([
			{ dataModelPath: "ReplicatedStorage/Client", fsPath: "src/Client" },
			{ dataModelPath: "ReplicatedStorage/Shared", fsPath: "src/Shared" },
			{ dataModelPath: "ServerScriptService/Server", fsPath: "src/Server" },
		]);
		expect(result.outDir).toBeUndefined();
		expect(result.exclude).toStrictEqual([]);
	});

	it("should respect segment boundaries during auto-expand", async () => {
		expect.assertions(1);

		const tree = {
			$className: "DataModel",
			ReplicatedStorage: {
				Client: { $path: "src/Client" },
			},
		} satisfies RojoTreeNode;

		const project = makeProject({
			displayName: "cli-only",
			// src/Cli must NOT match $path src/Client.
			include: ["src/Cli/**/*.spec.luau"],
		});

		await expect(
			resolveProject({
				project,
				rojoTree: tree,
				rootConfig,
			}),
		).rejects.toMatchObject({
			hint: SRC_HINT,
			message: expect.stringMatching(
				/include root "src\/Cli" did not match any Rojo \$path entry/,
			),
		});
	});

	it("should map an include root under an optional $path", async () => {
		expect.assertions(1);

		const tree = {
			$className: "DataModel",
			ReplicatedStorage: {
				tests: { $path: { optional: "src/tests" } },
			},
		} satisfies RojoTreeNode;

		const project = makeProject({
			displayName: "optional",
			include: ["src/tests/**/*.spec.luau"],
		});

		const result = await resolveProject({
			project,
			rojoTree: tree,
			rootConfig,
		});

		expect(result.rojoMounts).toStrictEqual([
			{ dataModelPath: "ReplicatedStorage/tests", fsPath: "src/tests" },
		]);
	});

	it("should skip file-valued $path entries during auto-expand", async () => {
		expect.assertions(1);

		const tree = {
			$className: "DataModel",
			ReplicatedStorage: {
				Constants: { $path: "src/shared/Constants.luau" },
				shared: { $path: "src/shared" },
			},
		} satisfies RojoTreeNode;

		const project = makeProject({
			displayName: "shared",
			include: ["src/shared/**/*.spec.luau"],
		});

		const kinds = mountKinds({
			"src/shared": "directory",
			"src/shared/Constants.luau": "file",
		});

		const result = await resolveProject({ kinds, project, rojoTree: tree, rootConfig });

		// The file-valued Constants.luau is not eligible; the exact-lookup
		// match on src/shared wins.
		expect(result.rojoMounts).toStrictEqual([
			{ dataModelPath: "ReplicatedStorage/shared", fsPath: "src/shared" },
		]);
	});

	it("should skip missing paths during auto-expand without throwing", async () => {
		expect.assertions(1);

		const tree = {
			$className: "DataModel",
			ReplicatedStorage: {
				Client: { $path: "src/Client" },
				Stale: { $path: "src/Stale" },
			},
		} satisfies RojoTreeNode;

		const project = makeProject({
			displayName: "partial",
			include: ["src/**/*.spec.luau"],
		});

		const kinds = mountKinds({
			"src/Client": "directory",
		});

		const result = await resolveProject({ kinds, project, rojoTree: tree, rootConfig });

		expect(result.rojoMounts).toStrictEqual([
			{ dataModelPath: "ReplicatedStorage/Client", fsPath: "src/Client" },
		]);
	});

	it("should prune descendant mounts when ancestor is present", async () => {
		expect.assertions(1);

		const tree = {
			$className: "DataModel",
			ReplicatedStorage: {
				Client: {
					$path: "src/Client",
					Systems: { $path: "src/Client/Systems" },
				},
			},
		} satisfies RojoTreeNode;

		const project = makeProject({
			displayName: "client",
			include: ["src/Client/**/*.spec.luau", "src/Client/Systems/**/*.spec.luau"],
		});

		const result = await resolveProject({
			project,
			rojoTree: tree,
			rootConfig,
		});

		expect(result.rojoMounts).toStrictEqual([
			{ dataModelPath: "ReplicatedStorage/Client", fsPath: "src/Client" },
		]);
	});

	it("should dedupe mounts when two include roots expand to the same mount", async () => {
		expect.assertions(1);

		const tree = {
			$className: "DataModel",
			ReplicatedStorage: {
				Shared: { $path: "src/Shared" },
			},
		} satisfies RojoTreeNode;

		const project = makeProject({
			displayName: "shared",
			// Both roots expand to the same mount under src/Shared.
			include: ["src/**/*.spec.luau", "src/Shared/**/*.test.luau"],
		});

		const result = await resolveProject({
			project,
			rojoTree: tree,
			rootConfig,
		});

		expect(result.rojoMounts).toStrictEqual([
			{ dataModelPath: "ReplicatedStorage/Shared", fsPath: "src/Shared" },
		]);
	});

	it("should produce deterministic order across roots that expand to disjoint mounts", async () => {
		expect.assertions(1);

		const tree = {
			$className: "DataModel",
			ReplicatedStorage: {
				A: { $path: "src/a" },
				B: { $path: "src/b" },
			},
		} satisfies RojoTreeNode;

		const project = makeProject({
			displayName: "ordered",
			include: ["src/a/**/*.spec.luau", "src/b/**/*.spec.luau"],
		});

		const result = await resolveProject({
			project,
			rojoTree: tree,
			rootConfig,
		});

		expect(result.projects).toStrictEqual(["ReplicatedStorage/A", "ReplicatedStorage/B"]);
	});

	it("should use exact lookup when outDir is set even with multiple include roots", async () => {
		expect.assertions(2);

		const project = makeProject({
			displayName: "pinned",
			include: ["src/client/**/*.spec.ts", "src/server/**/*.spec.ts"],
			outDir: "out/client",
		});

		const result = await resolveProject({
			project,
			rojoTree: simpleRojoTree,
			rootConfig,
		});

		expect(result.rojoMounts).toHaveLength(1);
		expect(result.rojoMounts).toStrictEqual([
			{ dataModelPath: "ReplicatedStorage/client", fsPath: "out/client" },
		]);
	});

	it("should throw when outDir is set but maps to no DataModel path", async () => {
		expect.assertions(1);

		const project = makeProject({
			displayName: "bad-outdir",
			include: ["src/client/**/*.spec.ts"],
			outDir: "out/nonexistent",
		});

		await expect(
			resolveProject({
				project,
				rojoTree: simpleRojoTree,
				rootConfig,
			}),
		).rejects.toMatchObject({
			hint: undefined,
			message: expect.stringMatching(/No Rojo tree mapping found for path: out\/nonexistent/),
		});
	});

	it("should apply project root before extracting include roots", async () => {
		expect.assertions(1);

		const tree = {
			$className: "DataModel",
			ReplicatedStorage: {
				Client: { $path: "packages/friends/src/Client" },
			},
		} satisfies RojoTreeNode;

		const project = makeProject({
			displayName: "friends",
			include: ["src/Client/**/*.spec.luau"],
			root: "packages/friends",
		});

		const result = await resolveProject({
			project,
			rojoTree: tree,
			rootConfig,
		});

		expect(result.rojoMounts).toStrictEqual([
			{
				dataModelPath: "ReplicatedStorage/Client",
				fsPath: "packages/friends/src/Client",
			},
		]);
	});

	it("should throw with nearby $path suggestions when include root is unmappable", async () => {
		expect.assertions(1);

		const tree = {
			$className: "DataModel",
			ReplicatedStorage: {
				Client: { $path: "out/Client" },
				Shared: { $path: "out/Shared" },
			},
		} satisfies RojoTreeNode;

		const project = makeProject({
			displayName: "lost",
			include: ["ghost/**/*.spec.luau"],
		});

		await expect(
			resolveProject({
				project,
				rojoTree: tree,
				rootConfig,
			}),
		).rejects.toMatchObject({
			hint: undefined,
			message: expect.stringMatching(/Available \$path entries: out\/Client, out\/Shared/),
		});
	});

	it("should omit available-entries line when rojo tree has no $path entries", async () => {
		expect.assertions(1);

		const emptyTree = { $className: "DataModel" } satisfies RojoTreeNode;

		const project = makeProject({
			displayName: "lost",
			include: ["ghost/**/*.spec.luau"],
		});

		const caught = await captureRejection(
			resolveProject({
				project,
				rojoTree: emptyTree,
				rootConfig,
			}),
		);

		expect(caught).toHaveProperty(
			"message",
			expect.not.stringMatching(/Available \$path entries/),
		);
	});

	it("should hint about outDir when unmappable root starts with src/", async () => {
		expect.assertions(1);

		const tree = {
			$className: "DataModel",
			ReplicatedStorage: {
				Client: { $path: "out/client" },
			},
		} satisfies RojoTreeNode;

		const project = makeProject({
			displayName: "hint-me",
			include: ["src/ghost/**/*.spec.ts"],
		});

		const caught = await captureRejection(
			resolveProject({ project, rojoTree: tree, rootConfig }),
		);

		expect(caught).toHaveProperty(
			"hint",
			'Path starts with "src/" — if using roblox-ts, set "outDir" in your project config to the compiled output directory (e.g. "out/client")',
		);
	});

	it("should omit the outDir hint when an unmappable root is outside src", async () => {
		expect.assertions(1);

		const project = makeProject({
			displayName: "no-hint",
			include: ["packages/ghost/**/*.spec.ts"],
		});

		const caught = await captureRejection(
			resolveProject({
				project,
				rojoTree: simpleRojoTree,
				rootConfig,
			}),
		);

		expect(caught).toHaveProperty("hint", undefined);
	});

	it("should resolve includes from cwd when root is not set", async () => {
		expect.assertions(1);

		const project = makeProject({
			displayName: "client",
			include: ["src/client/**/*.spec.ts"],
			outDir: "out/client",
		});

		const result = await resolveProject({
			project,
			rojoTree: simpleRojoTree,
			rootConfig,
		});

		expect(result.include).toStrictEqual(["src/client/**/*.spec.ts"]);
	});
});

describe("multi-root layouts", () => {
	const rootConfig: ResolvedConfig = { ...createResolvedConfig(), rootDir: CWD };

	const friendsPackageTree = {
		$className: "DataModel",
		ReplicatedStorage: {
			FriendsClient: {
				Components: { $path: "packages/friends-package/src/Client/Components" },
				Systems: { $path: "packages/friends-package/src/Client/Systems" },
			},
			FriendsIntegration: {
				$path: "packages/friends-package/test",
			},
			FriendsShared: {
				Network: { $path: "packages/friends-package/src/Shared/Network" },
				Types: { $path: "packages/friends-package/src/Shared/Types" },
			},
		},
		ServerScriptService: {
			FriendsServer: {
				Components: { $path: "packages/friends-package/src/Server/Components" },
				Systems: { $path: "packages/friends-package/src/Server/Systems" },
			},
		},
	} satisfies RojoTreeNode;

	const friendsInclude = [
		"packages/friends-package/src/**/*.spec.luau",
		"packages/friends-package/test/**/*.spec.luau",
	];

	const splitServicesTree = {
		$className: "DataModel",
		ReplicatedStorage: {
			$className: "ReplicatedStorage",
			PkgShared: { $path: "pkg/src/Shared" },
		},
		ServerScriptService: {
			$className: "ServerScriptService",
			PkgServer: { $path: "pkg/src/Server" },
		},
	} satisfies RojoTreeNode;

	it("should resolve rojoMounts for every touched service branch", async () => {
		expect.assertions(2);

		const resolved = await resolveProject({
			project: { displayName: "friends-package", include: friendsInclude },
			rojoTree: friendsPackageTree,
			rootConfig,
		});

		expect(resolved.rojoMounts).toStrictEqual([
			{
				dataModelPath: "ReplicatedStorage/FriendsClient/Components",
				fsPath: "packages/friends-package/src/Client/Components",
			},
			{
				dataModelPath: "ReplicatedStorage/FriendsClient/Systems",
				fsPath: "packages/friends-package/src/Client/Systems",
			},
			{
				dataModelPath: "ReplicatedStorage/FriendsShared/Network",
				fsPath: "packages/friends-package/src/Shared/Network",
			},
			{
				dataModelPath: "ReplicatedStorage/FriendsShared/Types",
				fsPath: "packages/friends-package/src/Shared/Types",
			},
			{
				dataModelPath: "ServerScriptService/FriendsServer/Components",
				fsPath: "packages/friends-package/src/Server/Components",
			},
			{
				dataModelPath: "ServerScriptService/FriendsServer/Systems",
				fsPath: "packages/friends-package/src/Server/Systems",
			},
			{
				dataModelPath: "ReplicatedStorage/FriendsIntegration",
				fsPath: "packages/friends-package/test",
			},
		]);
		expect(resolved.projects).toStrictEqual([
			"ReplicatedStorage/FriendsClient/Components",
			"ReplicatedStorage/FriendsClient/Systems",
			"ReplicatedStorage/FriendsShared/Network",
			"ReplicatedStorage/FriendsShared/Types",
			"ServerScriptService/FriendsServer/Components",
			"ServerScriptService/FriendsServer/Systems",
			"ReplicatedStorage/FriendsIntegration",
		]);
	});

	it("should pin a multi-root include to a single mount when outDir is set", async () => {
		expect.assertions(1);

		const resolved = await resolveProject({
			project: {
				displayName: "friends-client-only",
				include: friendsInclude,
				outDir: "packages/friends-package/src/Client/Components",
			},
			rojoTree: friendsPackageTree,
			rootConfig,
		});

		expect(resolved.rojoMounts).toStrictEqual([
			{
				dataModelPath: "ReplicatedStorage/FriendsClient/Components",
				fsPath: "packages/friends-package/src/Client/Components",
			},
		]);
	});

	it("should resolve exact-match roots when no mount exists on disk", async () => {
		expect.assertions(1);

		const resolved = await resolveProject({
			kinds: mountKinds({}),
			project: {
				displayName: "friends-test-only",
				include: ["packages/friends-package/test/**/*.spec.luau"],
			},
			rojoTree: friendsPackageTree,
			rootConfig,
		});

		expect(resolved.rojoMounts).toStrictEqual([
			{
				dataModelPath: "ReplicatedStorage/FriendsIntegration",
				fsPath: "packages/friends-package/test",
			},
		]);
	});

	it("should span services, mirror mounts in projects and leave outDir unset", async () => {
		expect.assertions(3);

		const resolved = await resolveProjects({
			projects: [{ displayName: "multi-root-e2e", include: ["pkg/src/**/*.spec.luau"] }],
			rojoTree: splitServicesTree,
			rootConfig,
		});

		expect(resolved.map((project) => project.rojoMounts)).toStrictEqual([
			[
				{ dataModelPath: "ReplicatedStorage/PkgShared", fsPath: "pkg/src/Shared" },
				{ dataModelPath: "ServerScriptService/PkgServer", fsPath: "pkg/src/Server" },
			],
		]);
		expect(resolved[0]!.projects).toStrictEqual([
			"ReplicatedStorage/PkgShared",
			"ServerScriptService/PkgServer",
		]);
		expect(resolved[0]!.outDir).toBeUndefined();
	});

	it("should pin a service-spanning include to the outDir mount", async () => {
		expect.assertions(1);

		const resolved = await resolveProject({
			project: {
				displayName: "shared-only",
				include: ["pkg/src/**/*.spec.luau"],
				outDir: "pkg/src/Shared",
			},
			rojoTree: splitServicesTree,
			rootConfig,
		});

		expect(resolved.rojoMounts).toStrictEqual([
			{ dataModelPath: "ReplicatedStorage/PkgShared", fsPath: "pkg/src/Shared" },
		]);
	});
});

describe(resolveAllProjects, () => {
	it("should resolve inline project entries", async () => {
		expect.assertions(2);

		const entries = [
			{
				test: makeProject({
					displayName: "client",
					include: ["src/client/**/*.spec.ts"],
					outDir: "out/client",
				}),
			},
		];

		const result = await resolveAllProjects({
			cwd: "/project",
			entries,
			fileSystem: createMemoryFileSystem().fileSystem,
			rojoTree: simpleRojoTree,
			rootConfig: createResolvedConfig(),
		});

		expect(result).toHaveLength(1);
		expect(result[0]!.displayName).toBe("client");
	});

	it("should load string entries via c12", async () => {
		expect.assertions(2);

		const { configLoader, seams } = createProjectSeams();
		configLoader.mockResolvedValueOnce({
			config: {
				displayName: "server",
				include: ["src/server/**/*.spec.ts"],
				outDir: "out/server",
			},
			configFile: "jest-project.config.ts",
			cwd: "/project",
			layers: [],
		});

		const entries = ["./server.config.ts"];

		const result = await resolveAllProjects({
			cwd: "/project",
			entries,
			rojoTree: simpleRojoTree,
			rootConfig: createResolvedConfig(),
			...seams,
		});

		expect(result).toHaveLength(1);
		expect(result[0]!.displayName).toBe("server");
	});

	it("should handle mixed inline and string entries", async () => {
		expect.assertions(3);

		const { configLoader, seams } = createProjectSeams();
		configLoader.mockResolvedValueOnce({
			config: {
				displayName: "server",
				include: ["src/server/**/*.spec.ts"],
				outDir: "out/server",
			},
			configFile: "jest-project.config.ts",
			cwd: "/project",
			layers: [],
		});

		const entries = [
			{
				test: makeProject({
					displayName: "client",
					include: ["src/client/**/*.spec.ts"],
					outDir: "out/client",
				}),
			},
			"./server.config.ts",
		];

		const result = await resolveAllProjects({
			cwd: "/project",
			entries,
			rojoTree: simpleRojoTree,
			rootConfig: createResolvedConfig(),
			...seams,
		});

		expect(result).toHaveLength(2);
		expect(result[0]!.displayName).toBe("client");
		expect(result[1]!.displayName).toBe("server");
	});

	it("should dedupe testMatch when multiple include roots strip to identical patterns", async () => {
		expect.assertions(1);

		const tree = {
			$className: "DataModel",
			ReplicatedStorage: {
				src: { $path: "src" },
				test: { $path: "test" },
			},
		} satisfies RojoTreeNode;

		const entries = [
			{
				test: makeProject({
					displayName: "shared",
					include: ["src/**/*.spec.luau", "test/**/*.spec.luau"],
				}),
			},
		];

		const result = await resolveAllProjects({
			cwd: "/project",
			entries,
			fileSystem: createMemoryFileSystem().fileSystem,
			rojoTree: tree,
			rootConfig: createResolvedConfig(),
		});

		expect(result[0]!.testMatch).toStrictEqual(["**/*.spec"]);
	});

	it("should throw when projects have duplicate names", async () => {
		expect.assertions(1);

		const entries = [
			{
				test: makeProject({
					displayName: "client",
					include: ["src/client/**/*.spec.ts"],
					outDir: "out/client",
				}),
			},
			{
				test: makeProject({
					displayName: "client",
					include: ["src/server/**/*.spec.ts"],
					outDir: "out/server",
				}),
			},
		];

		await expect(
			resolveAllProjects({
				cwd: "/project",
				entries,
				fileSystem: createMemoryFileSystem().fileSystem,
				rojoTree: simpleRojoTree,
				rootConfig: createResolvedConfig(),
			}),
		).rejects.toThrow("Duplicate project displayName: client");
	});
});
