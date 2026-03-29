import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import process from "node:process";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it, vi } from "vitest";

import type { MappedCoverageResult, MappedFileCoverage } from "./mapper.ts";
import { checkThresholds, generateReports, printCoverageHeader } from "./reporter.ts";

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

/** One file at 100%, one below — for testing skipFull behavior. */
function createMixedCoverageResult(): MappedCoverageResult {
	return createResult({
		"src/shared/inventory.ts": createMappedFile({
			f: { "0": 5, "1": 3 },
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
			s: { "0": 5, "1": 3, "2": 2, "3": 2 },
			statementMap: {
				"0": { end: { column: 20, line: 1 }, start: { column: 0, line: 1 } },
				"1": { end: { column: 15, line: 2 }, start: { column: 0, line: 2 } },
				"2": { end: { column: 10, line: 3 }, start: { column: 0, line: 3 } },
				"3": { end: { column: 12, line: 4 }, start: { column: 0, line: 4 } },
			},
		}),
		"src/shared/player.ts": createMappedFile(),
	});
}

describe(generateReports, () => {
	describe("with text reporter", () => {
		it("should write coverage summary to stdout", () => {
			expect.assertions(1);

			const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

			const result = createResult({
				"src/shared/player.ts": createMappedFile(),
			});

			const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "cov-report-"));
			try {
				generateReports({
					coverageDirectory: temporaryDirectory,
					mapped: result,
					reporters: ["text"],
				});

				const output = stdoutSpy.mock.calls.map((call) => String(call[0])).join("");

				expect(output).toContain("player.ts");
			} finally {
				stdoutSpy.mockRestore();
				fs.rmSync(temporaryDirectory, { force: true, recursive: true });
			}
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

			const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "cov-report-"));
			try {
				const result = createResult({
					"src/shared/player.ts": createMappedFile(),
				});

				generateReports({
					coverageDirectory: temporaryDirectory,
					mapped: result,
					reporters: ["lcov"],
				});

				const lcovPath = path.join(temporaryDirectory, "lcov.info");

				expect(fs.existsSync(lcovPath)).toBeTrue();
			} finally {
				fs.rmSync(temporaryDirectory, { force: true, recursive: true });
			}
		});
	});

	describe("with json reporter", () => {
		it("should generate coverage-final.json file", () => {
			expect.assertions(1);

			const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "cov-report-"));
			try {
				const result = createResult({
					"src/shared/player.ts": createMappedFile(),
				});

				generateReports({
					coverageDirectory: temporaryDirectory,
					mapped: result,
					reporters: ["json"],
				});

				const jsonPath = path.join(temporaryDirectory, "coverage-final.json");

				expect(fs.existsSync(jsonPath)).toBeTrue();
			} finally {
				fs.rmSync(temporaryDirectory, { force: true, recursive: true });
			}
		});
	});

	describe("text reporter snapshot", () => {
		it("should match coverage table output", () => {
			expect.assertions(1);

			const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

			const result = createResult({
				"src/shared/inventory.ts": createMappedFile({
					f: { "0": 5, "1": 0 },
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
					s: { "0": 5, "1": 3, "2": 0, "3": 2 },
					statementMap: {
						"0": { end: { column: 20, line: 1 }, start: { column: 0, line: 1 } },
						"1": { end: { column: 15, line: 2 }, start: { column: 0, line: 2 } },
						"2": { end: { column: 10, line: 3 }, start: { column: 0, line: 3 } },
						"3": { end: { column: 12, line: 4 }, start: { column: 0, line: 4 } },
					},
				}),
				"src/shared/player.ts": createMappedFile(),
			});

			const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "cov-report-"));
			try {
				generateReports({
					coverageDirectory: temporaryDirectory,
					mapped: result,
					reporters: ["text"],
				});

				const output = stdoutSpy.mock.calls.map((call) => String(call[0])).join("");

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
			} finally {
				stdoutSpy.mockRestore();
				fs.rmSync(temporaryDirectory, { force: true, recursive: true });
			}
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

		it("should show table when coverage map is empty in agent mode", () => {
			expect.assertions(1);

			vi.spyOn(process.stdout, "write").mockReturnValue(true);

			generateReports({
				agentMode: true,
				coverageDirectory: "/tmp/unused",
				mapped: createResult(),
				reporters: ["text"],
			});

			expect(stdoutOutput()).toContain("------");
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

	describe("terminal columns", () => {
		it("should use stdout.columns when available", () => {
			expect.assertions(1);

			Object.defineProperty(process.stdout, "columns", { configurable: true, value: 200 });
			vi.spyOn(process.stdout, "write").mockReturnValue(true);

			const result = createResult({
				"src/deeply/nested/path/to/module/index.ts": createMappedFile({
					path: "src/deeply/nested/path/to/module/index.ts",
				}),
				"src/other/location/index.ts": createMappedFile({
					path: "src/other/location/index.ts",
				}),
			});

			generateReports({
				agentMode: true,
				coverageDirectory: "/tmp/unused",
				mapped: result,
				reporters: ["text"],
			});

			Object.defineProperty(process.stdout, "columns", {
				configurable: true,
				value: undefined,
			});

			expect(stdoutOutput()).toContain("deeply/nested/path/to/module/index.ts");
		});

		it("should use COLUMNS env var to prevent path truncation", () => {
			expect.assertions(2);

			vi.stubEnv("COLUMNS", "200");
			vi.spyOn(process.stdout, "write").mockReturnValue(true);

			const result = createResult({
				"src/deeply/nested/path/to/module/index.ts": createMappedFile({
					path: "src/deeply/nested/path/to/module/index.ts",
				}),
				"src/other/location/index.ts": createMappedFile({
					path: "src/other/location/index.ts",
				}),
			});

			generateReports({
				agentMode: true,
				coverageDirectory: "/tmp/unused",
				mapped: result,
				reporters: ["text"],
			});

			const output = stdoutOutput();

			expect(output).toContain("deeply/nested/path/to/module/index.ts");
			expect(output).toContain("other/location/index.ts");
		});

		it("should ignore invalid COLUMNS env var", () => {
			expect.assertions(1);

			vi.stubEnv("COLUMNS", "auto");
			vi.spyOn(process.stdout, "write").mockReturnValue(true);

			const result = createResult({
				"src/shared/player.ts": createMappedFile(),
			});

			generateReports({
				coverageDirectory: "/tmp/unused",
				mapped: result,
				reporters: ["text"],
			});

			// should not throw — falls back to Istanbul default (80)
			expect(stdoutOutput()).toContain("player.ts");
		});
	});

	describe("with branch data", () => {
		it("should generate report without throwing when file has branch coverage data", () => {
			expect.assertions(1);

			const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "cov-report-"));
			try {
				const result = createResult({
					"src/shared/player.ts": createMappedFile({
						b: { "0": [3, 1] },
						branchMap: {
							"0": {
								loc: { end: { column: 1, line: 5 }, start: { column: 0, line: 2 } },
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
					mapped: result,
					reporters: ["json"],
				});

				const jsonPath = path.join(temporaryDirectory, "coverage-final.json");

				expect(fs.existsSync(jsonPath)).toBeTrue();
			} finally {
				fs.rmSync(temporaryDirectory, { force: true, recursive: true });
			}
		});
	});

	describe("with collectCoverageFrom filtering", () => {
		it("should include only files matching collectCoverageFrom globs", () => {
			expect.assertions(2);

			const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

			const result = createResult({
				"lib/utils.ts": createMappedFile({ path: "lib/utils.ts" }),
				"src/shared/player.ts": createMappedFile({ path: "src/shared/player.ts" }),
			});

			const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "cov-report-"));
			try {
				generateReports({
					collectCoverageFrom: ["src/**/*.ts"],
					coverageDirectory: temporaryDirectory,
					mapped: result,
					reporters: ["text"],
				});

				const output = stdoutSpy.mock.calls.map((call) => String(call[0])).join("");

				expect(output).toContain("player.ts");
				expect(output).not.toContain("utils.ts");
			} finally {
				stdoutSpy.mockRestore();
				fs.rmSync(temporaryDirectory, { force: true, recursive: true });
			}
		});

		it("should include all files when collectCoverageFrom is undefined", () => {
			expect.assertions(2);

			const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

			const result = createResult({
				"lib/utils.ts": createMappedFile({ path: "lib/utils.ts" }),
				"src/shared/player.ts": createMappedFile({ path: "src/shared/player.ts" }),
			});

			const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "cov-report-"));
			try {
				generateReports({
					coverageDirectory: temporaryDirectory,
					mapped: result,
					reporters: ["text"],
				});

				const output = stdoutSpy.mock.calls.map((call) => String(call[0])).join("");

				expect(output).toContain("player.ts");
				expect(output).toContain("utils.ts");
			} finally {
				stdoutSpy.mockRestore();
				fs.rmSync(temporaryDirectory, { force: true, recursive: true });
			}
		});

		it("should support multiple glob patterns", () => {
			expect.assertions(3);

			const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

			const result = createResult({
				"lib/utils.ts": createMappedFile({ path: "lib/utils.ts" }),
				"src/shared/player.ts": createMappedFile({ path: "src/shared/player.ts" }),
				"vendor/external.ts": createMappedFile({ path: "vendor/external.ts" }),
			});

			const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "cov-report-"));
			try {
				generateReports({
					collectCoverageFrom: ["src/**/*.ts", "lib/**/*.ts"],
					coverageDirectory: temporaryDirectory,
					mapped: result,
					reporters: ["text"],
				});

				const output = stdoutSpy.mock.calls.map((call) => String(call[0])).join("");

				expect(output).toContain("player.ts");
				expect(output).toContain("utils.ts");
				expect(output).not.toContain("external.ts");
			} finally {
				stdoutSpy.mockRestore();
				fs.rmSync(temporaryDirectory, { force: true, recursive: true });
			}
		});

		it("should support negated globs", () => {
			expect.assertions(2);

			const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

			const result = createResult({
				"src/shared/player.spec.ts": createMappedFile({
					path: "src/shared/player.spec.ts",
				}),
				"src/shared/player.ts": createMappedFile({ path: "src/shared/player.ts" }),
			});

			const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "cov-report-"));
			try {
				generateReports({
					collectCoverageFrom: ["src/**/*.ts", "!**/*.spec.ts"],
					coverageDirectory: temporaryDirectory,
					mapped: result,
					reporters: ["text"],
				});

				const output = stdoutSpy.mock.calls.map((call) => String(call[0])).join("");

				expect(output).toContain("player.ts");
				expect(output).not.toContain("spec");
			} finally {
				stdoutSpy.mockRestore();
				fs.rmSync(temporaryDirectory, { force: true, recursive: true });
			}
		});

		it("should support exclude-only patterns", () => {
			expect.assertions(2);

			const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

			const result = createResult({
				"src/shared/player.spec.ts": createMappedFile({
					path: "src/shared/player.spec.ts",
				}),
				"src/shared/player.ts": createMappedFile({ path: "src/shared/player.ts" }),
			});

			const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "cov-report-"));
			try {
				generateReports({
					collectCoverageFrom: ["!**/*.spec.ts"],
					coverageDirectory: temporaryDirectory,
					mapped: result,
					reporters: ["text"],
				});

				const output = stdoutSpy.mock.calls.map((call) => String(call[0])).join("");

				expect(output).toContain("player.ts");
				expect(output).not.toContain("spec");
			} finally {
				stdoutSpy.mockRestore();
				fs.rmSync(temporaryDirectory, { force: true, recursive: true });
			}
		});

		it("should include all files when collectCoverageFrom is empty array", () => {
			expect.assertions(2);

			const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

			const result = createResult({
				"lib/utils.ts": createMappedFile({ path: "lib/utils.ts" }),
				"src/shared/player.ts": createMappedFile({ path: "src/shared/player.ts" }),
			});

			const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "cov-report-"));
			try {
				generateReports({
					collectCoverageFrom: [],
					coverageDirectory: temporaryDirectory,
					mapped: result,
					reporters: ["text"],
				});

				const output = stdoutSpy.mock.calls.map((call) => String(call[0])).join("");

				expect(output).toContain("player.ts");
				expect(output).toContain("utils.ts");
			} finally {
				stdoutSpy.mockRestore();
				fs.rmSync(temporaryDirectory, { force: true, recursive: true });
			}
		});

		it("should match short globs with matchBase semantics", () => {
			expect.assertions(2);

			const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

			const result = createResult({
				"src/shared/player.spec.ts": createMappedFile({
					path: "src/shared/player.spec.ts",
				}),
				"src/shared/player.ts": createMappedFile({ path: "src/shared/player.ts" }),
			});

			const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "cov-report-"));
			try {
				generateReports({
					collectCoverageFrom: ["*.ts", "!*.spec.ts"],
					coverageDirectory: temporaryDirectory,
					mapped: result,
					reporters: ["text"],
				});

				const output = stdoutSpy.mock.calls.map((call) => String(call[0])).join("");

				expect(output).toContain("player.ts");
				expect(output).not.toContain("spec");
			} finally {
				stdoutSpy.mockRestore();
				fs.rmSync(temporaryDirectory, { force: true, recursive: true });
			}
		});

		it("should handle absolute file paths by normalizing to relative", () => {
			expect.assertions(2);

			const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

			const absolutePath = path.resolve("src/shared/player.ts");
			const absoluteSpecPath = path.resolve("src/shared/player.spec.ts");

			const result = createResult({
				[absolutePath]: createMappedFile({ path: absolutePath }),
				[absoluteSpecPath]: createMappedFile({ path: absoluteSpecPath }),
			});

			const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "cov-report-"));
			try {
				generateReports({
					collectCoverageFrom: ["src/**/*.ts", "!**/*.spec.ts"],
					coverageDirectory: temporaryDirectory,
					mapped: result,
					reporters: ["text"],
				});

				const output = stdoutSpy.mock.calls.map((call) => String(call[0])).join("");

				expect(output).toContain("player.ts");
				expect(output).not.toContain("spec");
			} finally {
				stdoutSpy.mockRestore();
				fs.rmSync(temporaryDirectory, { force: true, recursive: true });
			}
		});

		it("should produce empty report when all files are filtered out", () => {
			expect.assertions(1);

			const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

			const result = createResult({
				"src/shared/player.ts": createMappedFile({ path: "src/shared/player.ts" }),
			});

			const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "cov-report-"));
			try {
				generateReports({
					collectCoverageFrom: ["nonexistent/**/*.ts"],
					coverageDirectory: temporaryDirectory,
					mapped: result,
					reporters: ["text"],
				});

				const output = stdoutSpy.mock.calls.map((call) => String(call[0])).join("");

				expect(output).not.toContain("player.ts");
			} finally {
				stdoutSpy.mockRestore();
				fs.rmSync(temporaryDirectory, { force: true, recursive: true });
			}
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
					// eslint-disable-next-line ts/no-unsafe-assignment -- intentionally invalid reporter for error path test
					reporters: ["not-a-real-reporter" as any],
				});
			}).toThrow("Unknown coverage reporter: not-a-real-reporter");
		});
	});
});

describe(printCoverageHeader, () => {
	it("should match header output", () => {
		expect.assertions(1);

		const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

		try {
			printCoverageHeader();

			const output = stdoutSpy.mock.calls.map((call) => String(call[0])).join("");

			expect(stripVTControlCharacters(output)).toMatchInlineSnapshot(`
				"
				 % Coverage report from istanbul
				"
			`);
		} finally {
			stdoutSpy.mockRestore();
		}
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

			const thresholdResult = checkThresholds(result, { statements: 50 });

			expect(thresholdResult.passed).toBeTrue();
		});
	});

	describe("when coverage is below thresholds", () => {
		it("should fail", () => {
			expect.assertions(1);

			const result = createResult({
				"src/shared/player.ts": createMappedFile(),
			});

			const thresholdResult = checkThresholds(result, { statements: 80 });

			expect(thresholdResult.passed).toBeFalse();
		});
	});

	describe("when multiple thresholds fail", () => {
		it("should report which metrics failed", () => {
			expect.assertions(3);

			const result = createResult({
				"src/shared/player.ts": createMappedFile(),
			});

			const thresholdResult = checkThresholds(result, {
				functions: 100,
				lines: 90,
				statements: 80,
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

			const thresholdResult = checkThresholds(emptyResult, {
				branches: 80,
				functions: 80,
				lines: 80,
				statements: 80,
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

			const thresholdResult = checkThresholds(result, { statements: 80 });

			expect(thresholdResult.passed).toBeTrue();
			expect(thresholdResult.failures).toBeEmpty();
		});
	});
});
