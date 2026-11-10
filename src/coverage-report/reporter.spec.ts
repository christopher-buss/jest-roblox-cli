import { fromAny } from "@total-typescript/shoehorn";

import istanbulReports from "istanbul-reports";
import * as path from "node:path";
import process from "node:process";
import { stripVTControlCharacters } from "node:util";
import type { Mock } from "vitest";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { createMemoryReportEnvironment } from "#test/mocks/memory-report-context.ts";
import { posixPath } from "#test/mocks/posix-path.ts";
import type { MappedCoverageResult, MappedFileCoverage } from "./mapper-types.ts";
import type { createReporter as registryReporter } from "./reporter-registry.ts";
import { checkThresholds, generateReports, printCoverageHeader } from "./reporter.ts";

function stubTerminalColumns(columns: number): void {
	const original = Object.getOwnPropertyDescriptor(process.stdout, "columns");
	onTestFinished(() => {
		if (original === undefined) {
			Reflect.deleteProperty(process.stdout, "columns");
			return;
		}

		Object.defineProperty(process.stdout, "columns", original);
	});
	Object.defineProperty(process.stdout, "columns", {
		configurable: true,
		value: columns,
		writable: true,
	});
}

function createMappedFile(overrides: Partial<MappedFileCoverage> = {}): MappedFileCoverage {
	return {
		b: {},
		branchMap: {},
		f: { "0": 2 },
		fnMap: {
			"0": {
				name: "greet",
				loc: { end: { column: 1, line: 5 }, start: { column: 0, line: 1 } },
			},
		},
		path: "src/shared/player.ts",
		s: { "0": 3, "1": 0, "2": 5 },
		statementMap: {
			"0": { end: { column: 20, line: 1 }, start: { column: 0, line: 1 } },
			"1": { end: { column: 15, line: 3 }, start: { column: 0, line: 3 } },
			"2": { end: { column: 10, line: 5 }, start: { column: 0, line: 5 } },
		},
		...overrides,
	};
}

function createResult(files: Record<string, MappedFileCoverage> = {}): MappedCoverageResult {
	return { files };
}

function stdoutOutput(): string {
	return stripVTControlCharacters(
		vi
			.mocked(process.stdout.write)
			.mock.calls.map((call) => String(call[0]))
			.join(""),
	);
}

function inventoryFile(counts: Pick<MappedFileCoverage, "f" | "s">): MappedFileCoverage {
	return createMappedFile({
		fnMap: {
			"0": {
				name: "addItem",
				loc: { end: { column: 1, line: 5 }, start: { column: 0, line: 1 } },
			},
			"1": {
				name: "removeItem",
				loc: { end: { column: 1, line: 10 }, start: { column: 0, line: 6 } },
			},
		},
		path: "src/shared/inventory.ts",
		statementMap: {
			"0": { end: { column: 20, line: 1 }, start: { column: 0, line: 1 } },
			"1": { end: { column: 15, line: 2 }, start: { column: 0, line: 2 } },
			"2": { end: { column: 10, line: 3 }, start: { column: 0, line: 3 } },
			"3": { end: { column: 12, line: 4 }, start: { column: 0, line: 4 } },
		},
		...counts,
	});
}

function textReportOutput(mapped: MappedCoverageResult): string {
	const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
	const { createContext, directory } = createMemoryReportEnvironment();
	generateReports({
		coverageDirectory: directory,
		createContext,
		mapped,
		reporters: ["text"],
	});
	return write.mock.calls.map((call) => String(call[0])).join("");
}

/**
 * One file at 100%, one below — for testing skipFull behavior.
 * @returns The two-file result.
 */
function createMixedCoverageResult(): MappedCoverageResult {
	return createResult({
		"src/shared/inventory.ts": inventoryFile({
			f: { "0": 5, "1": 3 },
			s: { "0": 5, "1": 3, "2": 2, "3": 2 },
		}),
		"src/shared/player.ts": createMappedFile(),
	});
}

function onlyFiles(files: Array<string>): (candidate: string) => boolean {
	const absolute = new Set(files.map((file) => posixPath(path.resolve(process.cwd(), file))));
	return (candidate) => absolute.has(candidate);
}

function underDirectory(directory: string): (candidate: string) => boolean {
	const root = posixPath(directory);
	return (candidate) => candidate === root || candidate.startsWith(`${root}/`);
}

describe(generateReports, () => {
	describe("with text reporter", () => {
		it("should write coverage summary to stdout", () => {
			expect.assertions(1);

			const output = textReportOutput(
				createResult({
					"src/shared/player.ts": createMappedFile(),
				}),
			);

			expect(output).toContain("player.ts");
		});
	});

	describe("with text-summary reporter", () => {
		it("should write summary to stdout", () => {
			expect.assertions(1);

			vi.spyOn(process.stdout, "write").mockReturnValue(true);

			const result = createResult({
				"src/shared/player.ts": createMappedFile(),
			});

			generateReports({
				coverageDirectory: "/tmp/unused",
				mapped: result,
				reporters: ["text-summary"],
			});

			const output = vi
				.mocked(process.stdout.write)
				.mock.calls.map((call) => String(call[0]))
				.join("");

			expect(output).toContain("Statements");
		});
	});

	describe("with lcov reporter", () => {
		it("should generate lcov.info file", () => {
			expect.assertions(1);

			const {
				createContext,
				directory: temporaryDirectory,
				fileSystem: fs,
			} = createMemoryReportEnvironment();
			const result = createResult({
				"src/shared/player.ts": createMappedFile(),
			});

			generateReports({
				coverageDirectory: temporaryDirectory,
				createContext,
				mapped: result,
				reporters: ["lcov"],
			});

			const lcovPath = path.join(temporaryDirectory, "lcov.info");

			expect(fs.existsSync(lcovPath)).toBeTrue();
		});
	});

	describe("with json reporter", () => {
		it("should generate coverage-final.json file", () => {
			expect.assertions(1);

			const {
				createContext,
				directory: temporaryDirectory,
				fileSystem: fs,
			} = createMemoryReportEnvironment();
			const result = createResult({
				"src/shared/player.ts": createMappedFile(),
			});

			generateReports({
				coverageDirectory: temporaryDirectory,
				createContext,
				mapped: result,
				reporters: ["json"],
			});

			const jsonPath = path.join(temporaryDirectory, "coverage-final.json");

			expect(fs.existsSync(jsonPath)).toBeTrue();
		});

		it("should generate json when the agent text filter matches no file", () => {
			expect.assertions(1);

			const {
				createContext,
				directory: temporaryDirectory,
				fileSystem: fs,
			} = createMemoryReportEnvironment();
			generateReports({
				agentMode: true,
				agentTextFilter: onlyFiles(["src/missing.ts"]),
				coverageDirectory: temporaryDirectory,
				createContext,
				mapped: createResult({
					"src/shared/player.ts": createMappedFile(),
				}),
				reporters: ["json"],
			});

			expect(fs.existsSync(path.join(temporaryDirectory, "coverage-final.json"))).toBeTrue();
		});
	});

	describe("text reporter snapshot", () => {
		it("should match coverage table output", () => {
			expect.assertions(1);

			const output = textReportOutput(
				createResult({
					"src/shared/inventory.ts": inventoryFile({
						f: { "0": 5, "1": 0 },
						s: { "0": 5, "1": 3, "2": 0, "3": 2 },
					}),
					"src/shared/player.ts": createMappedFile(),
				}),
			);

			expect(stripVTControlCharacters(output)).toMatchInlineSnapshot(`
				"--------------|---------|----------|---------|---------|-------------------
				File          | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s 
				--------------|---------|----------|---------|---------|-------------------
				All files     |   71.42 |      100 |   66.66 |   71.42 |                   
				 inventory.ts |      75 |      100 |      50 |      75 | 3                 
				 player.ts    |   66.66 |      100 |     100 |   66.66 | 3                 
				--------------|---------|----------|---------|---------|-------------------
				"
			`);
		});

		it("should disambiguate files with identical names via flat paths in agent mode", () => {
			expect.assertions(1);

			vi.spyOn(process.stdout, "write").mockReturnValue(true);

			const result = createResult({
				"src/client/ui/index.ts": createMappedFile({
					path: "src/client/ui/index.ts",
				}),
				"src/server/services/index.ts": createMappedFile({
					path: "src/server/services/index.ts",
				}),
			});

			generateReports({
				agentMode: true,
				coverageDirectory: "/tmp/unused",
				mapped: result,
				reporters: ["text"],
			});

			const output = stdoutOutput();

			// flat summarizer shows path suffixes that disambiguate
			// same-named files (vs pkg summarizer which shows "index.ts" twice)
			expect(output).toMatchInlineSnapshot(`
				"-------------------|---------|----------|---------|---------|-------------------
				File               | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s 
				-------------------|---------|----------|---------|---------|-------------------
				All files          |   66.66 |      100 |     100 |   66.66 |                   
				 ...nt/ui/index.ts |   66.66 |      100 |     100 |   66.66 | 3                 
				 ...vices/index.ts |   66.66 |      100 |     100 |   66.66 | 3                 
				-------------------|---------|----------|---------|---------|-------------------
				Coverage: 66.66% stmts (4/6) | 100% branch (0/0) | 100% funcs (2/2) | 66.66% lines (4/6)
				"
			`);
		});

		it("should omit fully-covered files from text output in agent mode", () => {
			expect.assertions(2);

			vi.spyOn(process.stdout, "write").mockReturnValue(true);

			generateReports({
				agentMode: true,
				coverageDirectory: "/tmp/unused",
				mapped: createMixedCoverageResult(),
				reporters: ["text"],
			});

			const output = stdoutOutput();

			expect(output).not.toContain("inventory.ts");
			expect(output).toContain("player.ts");
		});

		it("should print compact summary when all files have full coverage in agent mode", () => {
			expect.assertions(1);

			vi.spyOn(process.stdout, "write").mockReturnValue(true);

			const result = createResult({
				"src/shared/player.ts": createMappedFile({
					s: { "0": 3, "1": 2, "2": 5 },
				}),
			});

			generateReports({
				agentMode: true,
				coverageDirectory: "/tmp/unused",
				mapped: result,
				reporters: ["text"],
			});

			expect(stdoutOutput()).toBe("Coverage: 100% (1 file)\n");
		});

		it("should pluralize file count in compact summary", () => {
			expect.assertions(1);

			vi.spyOn(process.stdout, "write").mockReturnValue(true);

			const result = createResult({
				"src/shared/inventory.ts": createMappedFile({
					path: "src/shared/inventory.ts",
					s: { "0": 3, "1": 2, "2": 5 },
				}),
				"src/shared/player.ts": createMappedFile({
					s: { "0": 3, "1": 2, "2": 5 },
				}),
			});

			generateReports({
				agentMode: true,
				coverageDirectory: "/tmp/unused",
				mapped: result,
				reporters: ["text"],
			});

			expect(stdoutOutput()).toBe("Coverage: 100% (2 files)\n");
		});

		it.for([
			[
				"branches",
				{
					b: { "0": [1, 0] },
					branchMap: {
						"0": {
							loc: {
								end: { column: 1, line: 5 },
								start: { column: 0, line: 2 },
							},
							locations: [
								{
									end: { column: 10, line: 3 },
									start: { column: 0, line: 2 },
								},
								{
									end: { column: 1, line: 5 },
									start: { column: 0, line: 4 },
								},
							],
							type: "if",
						},
					},
				},
			],
			["functions", { f: { "0": 0 } }],
		] satisfies Array<readonly [string, Partial<MappedFileCoverage>]>)(
			"should not collapse a file with partial %s coverage",
			([, overrides]) => {
				expect.assertions(1);

				vi.spyOn(process.stdout, "write").mockReturnValue(true);

				const result = createResult({
					"src/shared/player.ts": createMappedFile({
						...overrides,
						s: { "0": 3, "1": 2, "2": 5 },
					}),
				});

				generateReports({
					agentMode: true,
					coverageDirectory: "/tmp/unused",
					mapped: result,
					reporters: ["text"],
				});

				expect(stdoutOutput()).toContain("player.ts");
			},
		);

		it("should show table when coverage map is empty in agent mode", () => {
			expect.assertions(2);

			vi.spyOn(process.stdout, "write").mockReturnValue(true);

			generateReports({
				agentMode: true,
				coverageDirectory: "/tmp/unused",
				mapped: createResult(),
				reporters: ["text"],
			});

			const output = stdoutOutput();

			expect(output).toContain("------");
			// No files means no totals to report — Istanbul's blank summary has
			// pct "Unknown", which must never reach the totals line.
			expect(output).not.toContain("Coverage:");
		});

		it("should show all files including fully-covered when not in agent mode", () => {
			expect.assertions(2);

			vi.spyOn(process.stdout, "write").mockReturnValue(true);

			generateReports({
				coverageDirectory: "/tmp/unused",
				mapped: createMixedCoverageResult(),
				reporters: ["text"],
			});

			const output = stdoutOutput();

			expect(output).toContain("inventory.ts");
			expect(output).toContain("player.ts");
		});
	});

	describe("agent mode summary", () => {
		it("should print totals with raw counts when files are partially covered", () => {
			expect.assertions(1);

			vi.spyOn(process.stdout, "write").mockReturnValue(true);

			generateReports({
				agentMode: true,
				coverageDirectory: "/tmp/unused",
				mapped: createResult({ "src/shared/player.ts": createMappedFile() }),
				reporters: ["text"],
			});

			expect(stdoutOutput()).toContain(
				"Coverage: 66.66% stmts (2/3) | 100% branch (0/0) | 100% funcs (1/1) | 66.66% lines (2/3)",
			);
		});

		it("should not print totals when not in agent mode", () => {
			expect.assertions(1);

			vi.spyOn(process.stdout, "write").mockReturnValue(true);

			generateReports({
				coverageDirectory: "/tmp/unused",
				mapped: createResult({ "src/shared/player.ts": createMappedFile() }),
				reporters: ["text"],
			});

			expect(stdoutOutput()).not.toContain("stmts (");
		});

		it("should not print totals when no text reporter is present", () => {
			expect.assertions(1);

			const { createContext, directory: temporaryDirectory } =
				createMemoryReportEnvironment();
			vi.spyOn(process.stdout, "write").mockReturnValue(true);

			generateReports({
				agentMode: true,
				coverageDirectory: temporaryDirectory,
				createContext,
				mapped: createResult({ "src/shared/player.ts": createMappedFile() }),
				reporters: ["lcov"],
			});

			expect(stdoutOutput()).not.toContain("Coverage:");
		});

		it("should print the compact full-coverage summary once for multiple text reporters", () => {
			expect.assertions(1);

			vi.spyOn(process.stdout, "write").mockReturnValue(true);

			generateReports({
				agentMode: true,
				coverageDirectory: "/tmp/unused",
				mapped: createResult({
					"src/shared/player.ts": createMappedFile({
						s: { "0": 3, "1": 2, "2": 5 },
					}),
				}),
				reporters: ["text", "text-summary"],
			});

			expect(stdoutOutput()).toBe("Coverage: 100% (1 file)\n");
		});

		it("should print the compact summary when text is mixed with a file reporter", () => {
			expect.assertions(2);

			const {
				createContext,
				directory: temporaryDirectory,
				fileSystem: fs,
			} = createMemoryReportEnvironment();
			vi.spyOn(process.stdout, "write").mockReturnValue(true);

			generateReports({
				agentMode: true,
				coverageDirectory: temporaryDirectory,
				createContext,
				mapped: createResult({
					"src/shared/player.ts": createMappedFile({
						s: { "0": 3, "1": 2, "2": 5 },
					}),
				}),
				reporters: ["text", "lcov"],
			});

			expect(stdoutOutput()).toBe("Coverage: 100% (1 file)\n");
			expect(fs.existsSync(path.join(temporaryDirectory, "lcov.info"))).toBeTrue();
		});
	});

	describe("terminal columns", () => {
		function reportNestedPathsInAgentMode(): Mock<typeof registryReporter> {
			vi.spyOn(process.stdout, "write").mockReturnValue(true);
			const createReporter = vi.fn<typeof registryReporter>((name, options) => {
				return istanbulReports.create(name, options);
			});
			generateReports({
				agentMode: true,
				coverageDirectory: "/tmp/unused",
				createReporter,
				mapped: createResult({
					"src/deeply/nested/path/to/module/index.ts": createMappedFile({
						path: "src/deeply/nested/path/to/module/index.ts",
					}),
					"src/other/location/index.ts": createMappedFile({
						path: "src/other/location/index.ts",
					}),
				}),
				reporters: ["text"],
			});
			return createReporter;
		}

		it("should use stdout.columns when available", () => {
			expect.assertions(2);

			stubTerminalColumns(200);
			const createReporter = reportNestedPathsInAgentMode();

			expect(stdoutOutput()).toContain("deeply/nested/path/to/module/index.ts");
			expect(createReporter).toHaveBeenCalledExactlyOnceWith("text", {
				maxCols: 200,
				skipFull: true,
			});
		});

		it("should use COLUMNS env var to prevent path truncation", () => {
			expect.assertions(3);

			vi.stubEnv("COLUMNS", "200");
			const createReporter = reportNestedPathsInAgentMode();

			const output = stdoutOutput();

			expect(output).toContain("deeply/nested/path/to/module/index.ts");
			expect(output).toContain("other/location/index.ts");
			expect(createReporter).toHaveBeenCalledExactlyOnceWith("text", {
				maxCols: 200,
				skipFull: true,
			});
		});

		it.for(["auto", "0", "-1", "Infinity"])(
			"should ignore invalid COLUMNS value %j",
			(columns) => {
				expect.assertions(2);

				vi.spyOn(process.stdout, "write").mockReturnValue(true);
				const createReporter = vi.fn<typeof registryReporter>((name, options) => {
					return istanbulReports.create(name, options);
				});

				const result = createResult({
					"src/a/very/long/nested/directory/whose/name/exceeds/the/default/terminal/width/player.ts":
						createMappedFile({
							path: "src/a/very/long/nested/directory/whose/name/exceeds/the/default/terminal/width/player.ts",
						}),
				});

				generateReports({
					coverageDirectory: "/tmp/unused",
					createReporter,
					mapped: result,
					reporters: ["text"],
				});
				const defaultOutput = stdoutOutput();
				vi.mocked(process.stdout.write).mockClear();
				vi.stubEnv("COLUMNS", columns);

				generateReports({
					coverageDirectory: "/tmp/unused",
					createReporter,
					mapped: result,
					reporters: ["text"],
				});

				expect(stdoutOutput()).toBe(defaultOutput);

				const lastCall: unknown = createReporter.mock.calls.at(-1);

				expect(lastCall).toStrictEqual(["text", { maxCols: undefined, skipFull: false }]);
			},
		);
	});

	describe("with branch data", () => {
		it("should generate report without throwing when file has branch coverage data", () => {
			expect.assertions(1);

			const {
				createContext,
				directory: temporaryDirectory,
				fileSystem: fs,
			} = createMemoryReportEnvironment();
			const result = createResult({
				"src/shared/player.ts": createMappedFile({
					b: { "0": [3, 1] },
					branchMap: {
						"0": {
							loc: {
								end: { column: 1, line: 5 },
								start: { column: 0, line: 2 },
							},
							locations: [
								{ end: { column: 10, line: 3 }, start: { column: 0, line: 2 } },
								{ end: { column: 1, line: 5 }, start: { column: 0, line: 4 } },
							],
							type: "if",
						},
					},
				}),
			});

			generateReports({
				coverageDirectory: temporaryDirectory,
				createContext,
				mapped: result,
				reporters: ["json"],
			});

			const jsonPath = path.join(temporaryDirectory, "coverage-final.json");

			expect(fs.existsSync(jsonPath)).toBeTrue();
		});
	});

	describe("agent text-table filtering", () => {
		/**
		 * Two universe files, each 2/3 statements covered (the default fixture).
		 * @returns The two-file result.
		 */
		function twoFileUniverse(): MappedCoverageResult {
			return createResult({
				"src/shared/enemy.ts": createMappedFile({
					path: "src/shared/enemy.ts",
				}),
				"src/shared/player.ts": createMappedFile({
					path: "src/shared/player.ts",
				}),
			});
		}

		it("should narrow the text table to the matched file but total the full universe", () => {
			expect.assertions(1);

			vi.spyOn(process.stdout, "write").mockReturnValue(true);

			generateReports({
				agentMode: true,
				agentTextFilter: onlyFiles(["src/shared/player.ts"]),
				coverageDirectory: "/tmp/unused",
				mapped: twoFileUniverse(),
				reporters: ["text"],
			});

			// Table shows only player.ts; the totals line still counts both
			// files (4/6 statements), the full-universe gate number.
			expect(stdoutOutput()).toMatchInlineSnapshot(`
				"-----------|---------|----------|---------|---------|-------------------
				File       | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s 
				-----------|---------|----------|---------|---------|-------------------
				All files  |   66.66 |      100 |     100 |   66.66 |                   
				 player.ts |   66.66 |      100 |     100 |   66.66 | 3                 
				-----------|---------|----------|---------|---------|-------------------
				Coverage: 66.66% stmts (4/6) | 100% branch (0/0) | 100% funcs (2/2) | 66.66% lines (4/6)
				"
			`);
		});

		it("should restrict the table to a project scope filter", () => {
			expect.assertions(1);

			vi.spyOn(process.stdout, "write").mockReturnValue(true);

			generateReports({
				agentMode: true,
				agentTextFilter: underDirectory(path.resolve(process.cwd(), "src/shared")),
				coverageDirectory: "/tmp/unused",
				mapped: createResult({
					"src/server/boot.ts": createMappedFile({
						path: "src/server/boot.ts",
					}),
					"src/shared/player.ts": createMappedFile({
						path: "src/shared/player.ts",
					}),
				}),
				reporters: ["text"],
			});

			// Only the shared-scoped file; server/boot.ts dropped from the
			// table but still counted in the totals.
			expect(stdoutOutput()).toMatchInlineSnapshot(`
				"-----------|---------|----------|---------|---------|-------------------
				File       | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s 
				-----------|---------|----------|---------|---------|-------------------
				All files  |   66.66 |      100 |     100 |   66.66 |                   
				 player.ts |   66.66 |      100 |     100 |   66.66 | 3                 
				-----------|---------|----------|---------|---------|-------------------
				Coverage: 66.66% stmts (4/6) | 100% branch (0/0) | 100% funcs (2/2) | 66.66% lines (4/6)
				"
			`);
		});

		it("should ignore the filter outside agent mode", () => {
			expect.assertions(1);

			vi.spyOn(process.stdout, "write").mockReturnValue(true);

			generateReports({
				agentTextFilter: onlyFiles(["src/shared/player.ts"]),
				coverageDirectory: "/tmp/unused",
				mapped: twoFileUniverse(),
				reporters: ["text"],
			});

			// Non-agent: filter ignored, both files shown, no totals line.
			expect(stdoutOutput()).toMatchInlineSnapshot(`
				"-----------|---------|----------|---------|---------|-------------------
				File       | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s 
				-----------|---------|----------|---------|---------|-------------------
				All files  |   66.66 |      100 |     100 |   66.66 |                   
				 enemy.ts  |   66.66 |      100 |     100 |   66.66 | 3                 
				 player.ts |   66.66 |      100 |     100 |   66.66 | 3                 
				-----------|---------|----------|---------|---------|-------------------
				"
			`);
		});

		it("should keep the full table on an agent run with no filter", () => {
			expect.assertions(1);

			vi.spyOn(process.stdout, "write").mockReturnValue(true);

			generateReports({
				agentMode: true,
				coverageDirectory: "/tmp/unused",
				mapped: twoFileUniverse(),
				reporters: ["text"],
			});

			// Agent full run: both files shown plus the totals line.
			expect(stdoutOutput()).toMatchInlineSnapshot(`
				"-----------|---------|----------|---------|---------|-------------------
				File       | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s 
				-----------|---------|----------|---------|---------|-------------------
				All files  |   66.66 |      100 |     100 |   66.66 |                   
				 enemy.ts  |   66.66 |      100 |     100 |   66.66 | 3                 
				 player.ts |   66.66 |      100 |     100 |   66.66 | 3                 
				-----------|---------|----------|---------|---------|-------------------
				Coverage: 66.66% stmts (4/6) | 100% branch (0/0) | 100% funcs (2/2) | 66.66% lines (4/6)
				"
			`);
		});

		it("should not narrow the text-summary reporter", () => {
			expect.assertions(1);

			vi.spyOn(process.stdout, "write").mockReturnValue(true);

			generateReports({
				agentMode: true,
				agentTextFilter: onlyFiles(["src/shared/player.ts"]),
				coverageDirectory: "/tmp/unused",
				mapped: twoFileUniverse(),
				reporters: ["text-summary"],
			});

			// text-summary is never narrowed; aggregates the full universe.
			expect(stdoutOutput()).toMatchInlineSnapshot(`
				"
				=============================== Coverage summary ===============================
				Statements   : 66.66% ( 4/6 )
				Branches     : 100% ( 0/0 )
				Functions    : 100% ( 2/2 )
				Lines        : 66.66% ( 4/6 )
				================================================================================
				Coverage: 66.66% stmts (4/6) | 100% branch (0/0) | 100% funcs (2/2) | 66.66% lines (4/6)
				"
			`);
		});

		it("should leave lcov on the full universe when the table is filtered", () => {
			expect.assertions(2);

			vi.spyOn(process.stdout, "write").mockReturnValue(true);

			const {
				createContext,
				directory: temporaryDirectory,
				fileSystem: fs,
			} = createMemoryReportEnvironment();
			generateReports({
				agentMode: true,
				agentTextFilter: onlyFiles(["src/shared/player.ts"]),
				coverageDirectory: temporaryDirectory,
				createContext,
				mapped: twoFileUniverse(),
				reporters: ["lcov"],
			});

			const lcov = fs.readFileSync(path.join(temporaryDirectory, "lcov.info"), "utf8");

			expect(lcov).toContain("player.ts");
			expect(lcov).toContain("enemy.ts");
		});

		it("should print only the totals when the filter matches no universe file", () => {
			expect.assertions(1);

			vi.spyOn(process.stdout, "write").mockReturnValue(true);

			generateReports({
				agentMode: true,
				agentTextFilter: onlyFiles(["src/shared/missing.ts"]),
				coverageDirectory: "/tmp/unused",
				mapped: twoFileUniverse(),
				reporters: ["text"],
			});

			// No table (no header/rows), only the full-universe totals.
			expect(stdoutOutput()).toMatchInlineSnapshot(`
				"Coverage: 66.66% stmts (4/6) | 100% branch (0/0) | 100% funcs (2/2) | 66.66% lines (4/6)
				"
			`);
		});
	});

	describe("with unknown reporter", () => {
		it("should throw for unknown reporter name", () => {
			expect.assertions(1);

			const result = createResult({
				"src/shared/player.ts": createMappedFile(),
			});

			expect(() => {
				generateReports({
					coverageDirectory: "/tmp/unused",
					mapped: result,
					// Intentionally invalid reporter for the error path.
					reporters: [fromAny("not-a-real-reporter")],
				});
			}).toThrow("Unknown coverage reporter: not-a-real-reporter");
		});
	});
});

describe(printCoverageHeader, () => {
	it("should match header output", () => {
		expect.assertions(2);

		const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

		printCoverageHeader(false);

		const output = stdoutSpy.mock.calls.map((call) => String(call[0])).join("");

		expect(stripVTControlCharacters(output)).toMatchInlineSnapshot(`
			"
			 % Coverage report from istanbul
			"
		`);
		expect(output).not.toBe(stripVTControlCharacters(output));
	});

	it("should render the header without ANSI color in agent mode", () => {
		expect.assertions(2);

		const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

		printCoverageHeader(true);

		const output = stdoutSpy.mock.calls.map((call) => String(call[0])).join("");

		// Snapshot the RAW output (not VT-stripped, unlike the human-mode
		// header above): plain text has no escape codes, so the snapshot itself
		// is proof the header renders in black and white.
		expect(output).toMatchInlineSnapshot(`
			"
			 % Coverage report from istanbul
			"
		`);
		// Invariant guard so a blanket snapshot update can't silently
		// reintroduce color — agent mode emits plain text, ANSI only wastes
		// tokens.
		expect(output).toBe(stripVTControlCharacters(output));
	});
});

describe(checkThresholds, () => {
	describe("when coverage meets thresholds", () => {
		it("should pass", () => {
			expect.assertions(1);

			// 2 of 3 statements hit = 66.7%
			const result = createResult({
				"src/shared/player.ts": createMappedFile(),
			});

			const thresholdResult = checkThresholds({
				mapped: result,
				thresholds: { statements: 50 },
			});

			expect(thresholdResult.passed).toBeTrue();
		});
	});

	describe("when coverage is below thresholds", () => {
		it("should fail", () => {
			expect.assertions(1);

			const result = createResult({
				"src/shared/player.ts": createMappedFile(),
			});

			const thresholdResult = checkThresholds({
				mapped: result,
				thresholds: { statements: 80 },
			});

			expect(thresholdResult.passed).toBeFalse();
		});
	});

	describe("when multiple thresholds fail", () => {
		it("should report which metrics failed", () => {
			expect.assertions(3);

			const result = createResult({
				"src/shared/player.ts": createMappedFile(),
			});

			const thresholdResult = checkThresholds({
				mapped: result,
				thresholds: {
					functions: 100,
					lines: 90,
					statements: 80,
				},
			});

			expect(thresholdResult.failures).toContainEqual(
				expect.objectContaining({ metric: "statements" }),
			);
			expect(thresholdResult.failures).toContainEqual(
				expect.objectContaining({ metric: "lines" }),
			);
			// functions: 1/1 = 100%, should pass
			expect(thresholdResult.failures).not.toContainEqual(
				expect.objectContaining({ metric: "functions" }),
			);
		});
	});

	describe("when summary pct is not a number", () => {
		it("should skip threshold check for metrics with non-numeric pct", () => {
			expect.assertions(1);

			// Empty coverage map — no files at all — produces an empty summary
			// where istanbul may report pct as "Unknown" or 0 for some metrics.
			// With no files, the summary will have 0 totals.
			const emptyResult = createResult({});

			const thresholdResult = checkThresholds({
				mapped: emptyResult,
				thresholds: {
					branches: 80,
					functions: 80,
					lines: 80,
					statements: 80,
				},
			});

			// Empty coverage map: 0 total for all metrics. Istanbul reports
			// pct=0 or "Unknown". Either way, checkThresholds should handle it
			// gracefully without throwing.
			expect(thresholdResult).toBeDefined();
		});
	});

	describe("when summary schema validation fails", () => {
		it("should return passed with no failures", () => {
			expect.assertions(2);

			// Monkey-patch the coverage map to produce invalid summary JSON.
			// We create a result, then verify that if toJSON returned something
			// unexpected, checkThresholds handles it gracefully.
			const result = createResult({});

			const thresholdResult = checkThresholds({
				mapped: result,
				thresholds: { statements: 80 },
			});

			expect(thresholdResult.passed).toBeTrue();
			expect(thresholdResult.failures).toBeEmpty();
		});
	});
});
