import { describe, expect, it } from "vitest";

import { parseArgs } from "./cli-args.ts";

describe(parseArgs, () => {
	it("should return help when --help is passed", () => {
		expect.assertions(1);

		expect(parseArgs(["--help"]).help).toBeTrue();
	});

	it("should return version when --version is passed", () => {
		expect.assertions(1);

		expect(parseArgs(["--version"]).version).toBeTrue();
	});

	it("should parse --config option", () => {
		expect.assertions(1);

		expect(parseArgs(["--config", "./custom.config.ts"]).config).toBe("./custom.config.ts");
	});

	it("should parse --testPathPattern option", () => {
		expect.assertions(1);

		expect(parseArgs(["--testPathPattern", "player"]).testPathPattern).toBe("player");
	});

	it("should parse -t / --testNamePattern option", () => {
		expect.assertions(2);

		expect(parseArgs(["-t", "should spawn"]).testNamePattern).toBe("should spawn");
		expect(parseArgs(["--testNamePattern", "should spawn"]).testNamePattern).toBe(
			"should spawn",
		);
	});

	it("should parse --formatters json", () => {
		expect.assertions(1);

		expect(parseArgs(["--formatters", "json"]).formatters).toStrictEqual(["json"]);
	});

	it("should parse --outputFile option", () => {
		expect.assertions(1);

		expect(parseArgs(["--outputFile", "results.json"]).outputFile).toBe("results.json");
	});

	it("should parse --verbose flag", () => {
		expect.assertions(1);

		expect(parseArgs(["--verbose"]).verbose).toBeTrue();
	});

	it("should parse --silent flag", () => {
		expect.assertions(1);

		expect(parseArgs(["--silent"]).silent).toBeTrue();
	});

	it("should parse --bail flag", () => {
		expect.assertions(1);

		expect(parseArgs(["--bail"]).bail).toBeTrue();
	});

	it("should leave bail undefined without the flag", () => {
		expect.assertions(1);

		expect(parseArgs([]).bail).toBeUndefined();
	});

	it("should parse positional file arguments", () => {
		expect.assertions(1);

		const result = parseArgs(["src/test.spec.ts", "src/other.spec.ts"]);

		expect(result.files).toStrictEqual(["src/test.spec.ts", "src/other.spec.ts"]);
	});

	it("should parse related source files and keep the filters", () => {
		expect.assertions(2);

		const result = parseArgs([
			"related",
			"src/a.luau",
			"src/b.luau",
			"--project",
			"client",
			"-t",
			"spawn",
			"--testPathPattern",
			"unit",
		]);

		expect(result.files).toBeUndefined();
		expect(result).toMatchObject({
			project: ["client"],
			related: ["src/a.luau", "src/b.luau"],
			testNamePattern: "spawn",
			testPathPattern: "unit",
		});
	});

	it("should reject related with no source file", () => {
		expect.assertions(1);

		expect(() => parseArgs(["related"])).toThrow("related needs at least one source file.");
	});

	it("should pass a related run that selects no tests", () => {
		expect.assertions(2);

		expect(parseArgs(["related", "src/a.luau"]).passWithNoTests).toBeTrue();
		expect(parseArgs(["src/a.spec.luau"]).passWithNoTests).toBeUndefined();
	});

	it("should read a bare --changed as the uncommitted changes against HEAD", () => {
		expect.assertions(3);

		const result = parseArgs(["--changed", "--verbose"]);

		expect(result.changed).toBe("HEAD");
		expect(result.verbose).toBeTrue();
		expect(result.passWithNoTests).toBeTrue();
	});

	it("should read the ref after --changed", () => {
		expect.assertions(3);

		expect(parseArgs(["--changed", "origin/main"]).changed).toBe("origin/main");
		expect(parseArgs(["--changed=HEAD~2"]).changed).toBe("HEAD~2");
		expect(parseArgs(["--changed"]).changed).toBe("HEAD");
	});

	it("should reject a --changed ref that git would read as an option", () => {
		expect.assertions(1);

		expect(() => parseArgs(["--changed=--output=x"])).toThrow(
			'Invalid --changed ref "--output=x".',
		);
	});

	it("should reject related together with --changed", () => {
		expect.assertions(1);

		expect(() => parseArgs(["related", "src/a.luau", "--changed"])).toThrow(
			"related and --changed cannot be used together.",
		);
	});

	it("should leave related undefined on a run of positional files", () => {
		expect.assertions(1);

		expect(parseArgs(["src/a.spec.luau"]).related).toBeUndefined();
	});

	it("should leave files undefined when no positionals", () => {
		expect.assertions(1);

		expect(parseArgs([]).files).toBeUndefined();
	});

	it("should parse combined options and files", () => {
		expect.assertions(3);

		const result = parseArgs(["--verbose", "-t", "should pass", "src/test.spec.ts"]);

		expect(result.verbose).toBeTrue();
		expect(result.testNamePattern).toBe("should pass");
		expect(result.files).toStrictEqual(["src/test.spec.ts"]);
	});

	it("should parse --formatters agent", () => {
		expect.assertions(1);

		expect(parseArgs(["--formatters", "agent"]).formatters).toStrictEqual(["agent"]);
	});

	it("should reject --no-cache as an unknown option", () => {
		expect.assertions(1);

		expect(() => parseArgs(["--no-cache"])).toThrow(/Unknown option/);
	});

	it("should reject --cache as an unknown option", () => {
		expect.assertions(1);

		expect(() => parseArgs(["--cache"])).toThrow(/Unknown option/);
	});

	it("should parse --no-coverage-cache flag", () => {
		expect.assertions(2);

		expect(parseArgs(["--no-coverage-cache"]).coverageCache).toBeFalse();
		expect(parseArgs(["--coverage-cache"]).coverageCache).toBeTrue();
	});

	it("should let --no-coverage-cache take precedence over --coverage-cache", () => {
		expect.assertions(1);

		expect(parseArgs(["--coverage-cache", "--no-coverage-cache"]).coverageCache).toBeFalse();
	});

	it("should parse --no-upload-cache flag", () => {
		expect.assertions(1);

		expect(parseArgs(["--no-upload-cache"]).uploadCache).toBeFalse();
	});

	it("should leave uploadCache unset when the flag is absent", () => {
		expect.assertions(1);

		expect(parseArgs([]).uploadCache).toBeUndefined();
	});

	it.for(["--binary-input", "--no-binary-input"])(
		"should reject %s as an unknown option",
		(flag) => {
			expect.assertions(1);

			expect(() => parseArgs([flag])).toThrow(/Unknown option/);
		},
	);

	it("should parse color flags and prefer --no-color", () => {
		expect.assertions(3);

		expect(parseArgs(["--no-color"]).color).toBeFalse();
		expect(parseArgs(["--color"]).color).toBeTrue();
		expect(parseArgs(["--color", "--no-color"]).color).toBeFalse();
	});

	it("should parse --gameOutput option", () => {
		expect.assertions(1);

		expect(parseArgs(["--gameOutput", "/tmp/game.json"]).gameOutput).toBe("/tmp/game.json");
	});

	it("should parse Luau display flags and prefer --no-show-luau", () => {
		expect.assertions(3);

		expect(parseArgs(["--no-show-luau"]).showLuau).toBeFalse();
		expect(parseArgs(["--showLuau"]).showLuau).toBeTrue();
		expect(parseArgs(["--showLuau", "--no-show-luau"]).showLuau).toBeFalse();
	});

	it("should parse -u / --updateSnapshot flag", () => {
		expect.assertions(2);

		expect(parseArgs(["-u"]).updateSnapshot).toBeTrue();
		expect(parseArgs(["--updateSnapshot"]).updateSnapshot).toBeTrue();
	});

	it("should leave typecheck unset without either flag", () => {
		expect.assertions(1);

		expect(parseArgs([]).typecheck).toBeUndefined();
	});

	it("should parse --typecheck flag", () => {
		expect.assertions(1);

		expect(parseArgs(["--typecheck"]).typecheck).toBeTrue();
	});

	it("should parse --typecheckOnly flag and imply --typecheck", () => {
		expect.assertions(2);

		const result = parseArgs(["--typecheckOnly"]);

		expect(result.typecheckOnly).toBeTrue();
		expect(result.typecheck).toBeTrue();
	});

	it("should parse --typecheckTsconfig option", () => {
		expect.assertions(1);

		expect(parseArgs(["--typecheckTsconfig", "tsconfig.test.json"]).typecheckTsconfig).toBe(
			"tsconfig.test.json",
		);
	});

	it("should parse valid --backend values", () => {
		expect.assertions(4);

		expect(parseArgs(["--backend", "auto"]).backend).toBe("auto");
		expect(parseArgs(["--backend", "open-cloud"]).backend).toBe("open-cloud");
		expect(parseArgs(["--backend", "studio"]).backend).toBe("studio");
		expect(parseArgs(["--backend", "studio-cli"]).backend).toBe("studio-cli");
	});

	it("should parse --studioPath", () => {
		expect.assertions(2);

		expect(parseArgs(["--studioPath", "C:/Studio/RobloxStudioBeta.exe"]).studioPath).toBe(
			"C:/Studio/RobloxStudioBeta.exe",
		);
		expect(parseArgs([]).studioPath).toBeUndefined();
	});

	it("should parse --headed", () => {
		expect.assertions(2);

		expect(parseArgs(["--headed"]).headed).toBeTrue();
		expect(parseArgs([]).headed).toBeUndefined();
	});

	it("should parse --hiddenDesktop", () => {
		expect.assertions(2);

		expect(parseArgs(["--hiddenDesktop"]).hiddenDesktop).toBeTrue();
		expect(parseArgs([]).hiddenDesktop).toBeUndefined();
	});

	it("should parse --no-hiddenDesktop as false", () => {
		expect.assertions(1);

		expect(parseArgs(["--no-hiddenDesktop"]).hiddenDesktop).toBeFalse();
	});

	it("should leave backend undefined when not passed", () => {
		expect.assertions(1);

		expect(parseArgs([]).backend).toBeUndefined();
	});

	it("should throw on invalid --backend value", () => {
		expect.assertions(2);

		expect(() => parseArgs(["--backend", "not-a-backend"])).toThrow(
			'Invalid backend "not-a-backend"',
		);
		expect(() => parseArgs(["--backend", "invalid"])).toThrow(
			"Must be one of: auto, open-cloud, studio, studio-cli",
		);
	});

	it("should parse --coverage flag", () => {
		expect.assertions(1);

		expect(parseArgs(["--coverage"]).collectCoverage).toBeTrue();
	});

	it("should parse --no-coverage flag", () => {
		expect.assertions(1);

		expect(parseArgs(["--no-coverage"]).collectCoverage).toBeFalse();
	});

	it("should let --no-coverage take precedence over --coverage when both are passed", () => {
		expect.assertions(1);

		expect(parseArgs(["--coverage", "--no-coverage"]).collectCoverage).toBeFalse();
	});

	it("should parse --coverageDirectory option", () => {
		expect.assertions(1);

		expect(parseArgs(["--coverageDirectory", "my-coverage"]).coverageDirectory).toBe(
			"my-coverage",
		);
	});

	it("should parse --coverageReporters with multiple values", () => {
		expect.assertions(1);

		const result = parseArgs([
			"--coverageReporters",
			"text",
			"--coverageReporters",
			"lcov",
			"--coverageReporters",
			"html",
		]);

		expect(result.coverageReporters).toStrictEqual(["text", "lcov", "html"]);
	});

	it("should report every invalid --coverageReporters value", () => {
		expect.assertions(1);

		expect(() => {
			return parseArgs([
				"--coverageReporters",
				"bad-one",
				"--coverageReporters",
				"text",
				"--coverageReporters",
				"bad-two",
			]);
		}).toThrow(
			'Invalid coverage reporter "bad-one", "bad-two". Must be one of: clover, cobertura, html, html-spa, json, json-summary, lcov, lcovonly, none, teamcity, text, text-lcov, text-summary',
		);
	});

	it("should parse --collectCoverageFrom with multiple values", () => {
		expect.assertions(1);

		const result = parseArgs([
			"--collectCoverageFrom",
			"src/**/*.ts",
			"--collectCoverageFrom",
			"lib/**/*.ts",
		]);

		expect(result.collectCoverageFrom).toStrictEqual(["src/**/*.ts", "lib/**/*.ts"]);
	});

	it("should leave collectCoverageFrom undefined when not passed", () => {
		expect.assertions(1);

		expect(parseArgs([]).collectCoverageFrom).toBeUndefined();
	});

	it("should parse --port option", () => {
		expect.assertions(2);

		expect(parseArgs(["--port", "4000"]).port).toBe(4000);
		expect(parseArgs([]).port).toBeUndefined();
	});

	it("should parse --timeout option", () => {
		expect.assertions(2);

		expect(parseArgs(["--timeout", "60000"]).timeout).toBe(60000);
		expect(parseArgs([]).timeout).toBeUndefined();
	});

	it.for([
		["--port", "abc"],
		["--port", "30x"],
		["--port", "0"],
		["--timeout", "slow"],
		["--timeout", "1.5"],
		["--timeout", "-5"],
	])("should reject %s %j", ([flag, value]) => {
		expect.assertions(1);

		expect(() => parseArgs([`${flag}=${value}`])).toThrow(
			`Invalid ${flag} value "${value}". Must be a positive integer.`,
		);
	});

	it("should parse single --project flag", () => {
		expect.assertions(1);

		expect(parseArgs(["--project", "client"]).project).toStrictEqual(["client"]);
	});

	it("should parse multiple --project flags", () => {
		expect.assertions(1);

		const result = parseArgs(["--project", "client", "--project", "server"]);

		expect(result.project).toStrictEqual(["client", "server"]);
	});

	it("should keep a positional file alongside --project", () => {
		expect.assertions(1);

		const result = parseArgs(["--project", "client", "src/player.spec.ts"]);

		expect(result).toMatchObject({ files: ["src/player.spec.ts"], project: ["client"] });
	});

	it("should parse --passWithNoTests flag", () => {
		expect.assertions(1);

		expect(parseArgs(["--passWithNoTests"]).passWithNoTests).toBeTrue();
	});

	it.for(["--parallel", "--experimental-vm-parallel"])(
		"should leave a positional test path after bare %s",
		(flag) => {
			expect.assertions(1);

			expect(parseArgs([flag, "src/example.spec.ts"]).files).toStrictEqual([
				"src/example.spec.ts",
			]);
		},
	);

	it("should parse --parallel with integer value", () => {
		expect.assertions(2);

		expect(parseArgs(["--parallel", "3"]).parallel).toBe(3);
		expect(parseArgs(["--parallel", "12"]).parallel).toBe(12);
	});

	it('should parse --parallel with "auto"', () => {
		expect.assertions(2);

		const result = parseArgs(["--parallel", "auto"]);

		expect(result.parallel).toBe("auto");
		expect(result.files).toBeUndefined();
	});

	it('should treat bare --parallel (no value) as "auto"', () => {
		expect.assertions(1);

		expect(parseArgs(["--parallel"]).parallel).toBe("auto");
	});

	it("should treat --parallel followed by another flag as auto", () => {
		expect.assertions(2);

		const result = parseArgs(["--parallel", "--verbose"]);

		expect(result.parallel).toBe("auto");
		expect(result.verbose).toBeTrue();
	});

	it("should leave a negative positional for the argument parser", () => {
		expect.assertions(1);

		expect(() => parseArgs(["--parallel", "-1"])).toThrow("Unknown option '-1'");
	});

	it("should leave parallel undefined when flag not present", () => {
		expect.assertions(1);

		expect(parseArgs([]).parallel).toBeUndefined();
	});

	it("should throw on --parallel 0", () => {
		expect.assertions(1);

		expect(() => parseArgs(["--parallel", "0"])).toThrow("Invalid --parallel value");
	});

	it("should accept the minimum --parallel value", () => {
		expect.assertions(1);

		expect(parseArgs(["--parallel", "1"]).parallel).toBe(1);
	});

	it("should throw on --parallel -1", () => {
		expect.assertions(1);

		expect(() => parseArgs(["--parallel=-1"])).toThrow("Invalid --parallel value");
	});

	it("should throw on --parallel non-numeric", () => {
		expect.assertions(1);

		expect(() => parseArgs(["--parallel=xyz"])).toThrow("Invalid --parallel value");
	});

	it.for(["3x", "x3"])(
		"should reject attached partially numeric --parallel value %j",
		(value) => {
			expect.assertions(1);

			expect(() => parseArgs([`--parallel=${value}`])).toThrow("Invalid --parallel value");
		},
	);

	it("should parse --experimental-vm-parallel with integer value", () => {
		expect.assertions(2);

		expect(parseArgs(["--experimental-vm-parallel", "3"]).experimentalVmParallel).toBe(3);
		expect(parseArgs(["--experimental-vm-parallel", "1"]).experimentalVmParallel).toBe(1);
	});

	it('should treat bare --experimental-vm-parallel as "auto"', () => {
		expect.assertions(1);

		expect(parseArgs(["--experimental-vm-parallel"]).experimentalVmParallel).toBe("auto");
	});

	it('should consume "auto" as the --experimental-vm-parallel value, not a test path', () => {
		expect.assertions(2);

		const result = parseArgs(["--experimental-vm-parallel", "auto"]);

		expect(result.experimentalVmParallel).toBe("auto");
		expect(result.files).toBeUndefined();
	});

	it("should treat --experimental-vm-parallel followed by another flag as auto", () => {
		expect.assertions(2);

		const result = parseArgs(["--experimental-vm-parallel", "--verbose"]);

		expect(result.experimentalVmParallel).toBe("auto");
		expect(result.verbose).toBeTrue();
	});

	it("should leave experimentalVmParallel undefined when flag not present", () => {
		expect.assertions(1);

		expect(parseArgs([]).experimentalVmParallel).toBeUndefined();
	});

	it("should throw on --experimental-vm-parallel 0", () => {
		expect.assertions(1);

		expect(() => parseArgs(["--experimental-vm-parallel", "0"])).toThrow(
			"Invalid --experimental-vm-parallel value",
		);
	});

	it("should throw on --experimental-vm-parallel non-numeric", () => {
		expect.assertions(1);

		expect(() => parseArgs(["--experimental-vm-parallel=xyz"])).toThrow(
			"Invalid --experimental-vm-parallel value",
		);
	});

	it("should parse --apiKey option", () => {
		expect.assertions(1);

		expect(parseArgs(["--apiKey", "secret"]).apiKey).toBe("secret");
	});

	it("should parse --universeId option", () => {
		expect.assertions(1);

		expect(parseArgs(["--universeId", "123"]).universeId).toBe("123");
	});

	it("should parse --placeId option", () => {
		expect.assertions(1);

		expect(parseArgs(["--placeId", "456"]).placeId).toBe("456");
	});

	it("should parse all three credential flags together", () => {
		expect.assertions(3);

		const result = parseArgs(["--apiKey", "secret", "--universeId", "123", "--placeId", "456"]);

		expect(result.apiKey).toBe("secret");
		expect(result.universeId).toBe("123");
		expect(result.placeId).toBe("456");
	});

	it("should leave credential fields undefined when flags are absent", () => {
		expect.assertions(3);

		const result = parseArgs([]);

		expect(result.apiKey).toBeUndefined();
		expect(result.universeId).toBeUndefined();
		expect(result.placeId).toBeUndefined();
	});

	it("should parse --workspace flag", () => {
		expect.assertions(1);

		expect(parseArgs(["--workspace"]).workspace).toBeTrue();
	});

	it("should parse --packages option", () => {
		expect.assertions(1);

		expect(parseArgs(["--packages", "foo,bar"]).packages).toBe("foo,bar");
	});

	it("should parse --affected-since option", () => {
		expect.assertions(1);

		expect(parseArgs(["--affected-since", "main"]).affectedSince).toBe("main");
	});

	it("should parse --workspace-root option", () => {
		expect.assertions(1);

		expect(parseArgs(["--workspace-root", "./pkgs/testing"]).workspaceRoot).toBe(
			"./pkgs/testing",
		);
	});

	it("should parse --setupFiles list", () => {
		expect.assertions(1);

		const result = parseArgs(["--setupFiles", "a.ts", "--setupFiles", "b.ts"]);

		expect(result.setupFiles).toStrictEqual(["a.ts", "b.ts"]);
	});

	it("should parse --setupFilesAfterEnv list", () => {
		expect.assertions(1);

		const result = parseArgs(["--setupFilesAfterEnv", "x.ts", "--setupFilesAfterEnv", "y.ts"]);

		expect(result.setupFilesAfterEnv).toStrictEqual(["x.ts", "y.ts"]);
	});

	it("should parse --rojoProject option", () => {
		expect.assertions(1);

		expect(parseArgs(["--rojoProject", "custom.project.json"]).rojoProject).toBe(
			"custom.project.json",
		);
	});

	it("should parse --sourceMap flag", () => {
		expect.assertions(1);

		expect(parseArgs(["--sourceMap"]).sourceMap).toBeTrue();
	});
});
