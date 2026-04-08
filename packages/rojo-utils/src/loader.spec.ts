import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { loadRojoProject } from "./loader.ts";

describe(loadRojoProject, () => {
	it("should load and parse a valid Rojo project", () => {
		expect.assertions(2);

		const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rojo-loader-test-"));
		const projectPath = path.join(temporaryDirectory, "default.project.json");
		fs.writeFileSync(
			projectPath,
			JSON.stringify({
				name: "TestProject",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						shared: { $path: "src/shared" },
					},
				},
			}),
		);

		try {
			const project = loadRojoProject(projectPath);

			expect(project.name).toBe("TestProject");
			expect(project.tree).toStrictEqual({
				$className: "DataModel",
				ReplicatedStorage: {
					shared: { $path: "src/shared" },
				},
			});
		} finally {
			fs.rmSync(temporaryDirectory, { force: true, recursive: true });
		}
	});

	it("should resolve nested project references", () => {
		expect.assertions(1);

		const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rojo-loader-test-"));
		fs.writeFileSync(
			path.join(temporaryDirectory, "inner.project.json"),
			JSON.stringify({ name: "Inner", tree: { $path: "src/inner" } }),
		);
		const projectPath = path.join(temporaryDirectory, "default.project.json");
		fs.writeFileSync(
			projectPath,
			JSON.stringify({
				name: "Outer",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						inner: { $path: "inner.project.json" },
					},
				},
			}),
		);

		try {
			const project = loadRojoProject(projectPath);

			expect(project.tree["ReplicatedStorage"]).toStrictEqual({
				inner: { $path: "src/inner" },
			});
		} finally {
			fs.rmSync(temporaryDirectory, { force: true, recursive: true });
		}
	});

	it("should preserve servePort when present", () => {
		expect.assertions(1);

		const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rojo-loader-test-"));
		const projectPath = path.join(temporaryDirectory, "default.project.json");
		fs.writeFileSync(
			projectPath,
			JSON.stringify({
				name: "TestProject",
				servePort: 34872,
				tree: { $className: "DataModel" },
			}),
		);

		try {
			const project = loadRojoProject(projectPath);

			expect(project.servePort).toBe(34872);
		} finally {
			fs.rmSync(temporaryDirectory, { force: true, recursive: true });
		}
	});

	it("should not include servePort when absent", () => {
		expect.assertions(1);

		const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rojo-loader-test-"));
		const projectPath = path.join(temporaryDirectory, "default.project.json");
		fs.writeFileSync(
			projectPath,
			JSON.stringify({
				name: "TestProject",
				tree: { $className: "DataModel" },
			}),
		);

		try {
			const project = loadRojoProject(projectPath);

			expect(project.servePort).toBeUndefined();
		} finally {
			fs.rmSync(temporaryDirectory, { force: true, recursive: true });
		}
	});

	it("should throw with file path when project has malformed JSON", () => {
		expect.assertions(1);

		const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rojo-loader-test-"));
		const projectPath = path.join(temporaryDirectory, "bad.project.json");
		fs.writeFileSync(projectPath, "not valid json {{{");

		try {
			expect(() => loadRojoProject(projectPath)).toThrow("Failed to parse Rojo project");
		} finally {
			fs.rmSync(temporaryDirectory, { force: true, recursive: true });
		}
	});

	it("should throw when file does not exist", () => {
		expect.assertions(1);

		expect(() => loadRojoProject("/nonexistent/project.json")).toThrow(
			"Could not read Rojo project",
		);
	});

	it("should throw when name is missing", () => {
		expect.assertions(1);

		const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rojo-loader-test-"));
		const projectPath = path.join(temporaryDirectory, "bad.project.json");
		fs.writeFileSync(projectPath, JSON.stringify({ tree: { $className: "DataModel" } }));

		try {
			expect(() => loadRojoProject(projectPath)).toThrow(
				'Rojo project must have a non-empty "name" field',
			);
		} finally {
			fs.rmSync(temporaryDirectory, { force: true, recursive: true });
		}
	});

	it("should throw when name is empty string", () => {
		expect.assertions(1);

		const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rojo-loader-test-"));
		const projectPath = path.join(temporaryDirectory, "bad.project.json");
		fs.writeFileSync(
			projectPath,
			JSON.stringify({ name: "", tree: { $className: "DataModel" } }),
		);

		try {
			expect(() => loadRojoProject(projectPath)).toThrow(
				'Rojo project must have a non-empty "name" field',
			);
		} finally {
			fs.rmSync(temporaryDirectory, { force: true, recursive: true });
		}
	});

	it("should throw when tree is missing", () => {
		expect.assertions(1);

		const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rojo-loader-test-"));
		const projectPath = path.join(temporaryDirectory, "bad.project.json");
		fs.writeFileSync(projectPath, JSON.stringify({ name: "Bad" })!);

		try {
			expect(() => loadRojoProject(projectPath)).toThrow(
				'Rojo project must have a "tree" object',
			);
		} finally {
			fs.rmSync(temporaryDirectory, { force: true, recursive: true });
		}
	});

	it("should throw when tree is an array", () => {
		expect.assertions(1);

		const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rojo-loader-test-"));
		const projectPath = path.join(temporaryDirectory, "bad.project.json");
		fs.writeFileSync(projectPath, JSON.stringify({ name: "Bad", tree: [] }));

		try {
			expect(() => loadRojoProject(projectPath)).toThrow(
				'Rojo project must have a "tree" object',
			);
		} finally {
			fs.rmSync(temporaryDirectory, { force: true, recursive: true });
		}
	});

	it("should throw when tree is null", () => {
		expect.assertions(1);

		const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rojo-loader-test-"));
		const projectPath = path.join(temporaryDirectory, "bad.project.json");
		fs.writeFileSync(projectPath, JSON.stringify({ name: "Bad", tree: null }));

		try {
			expect(() => loadRojoProject(projectPath)).toThrow(
				'Rojo project must have a "tree" object',
			);
		} finally {
			fs.rmSync(temporaryDirectory, { force: true, recursive: true });
		}
	});
});
