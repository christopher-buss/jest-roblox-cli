import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";

import { loadRojoProject } from "./loader.ts";

function createTemporaryDirectory(): string {
	const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rojo-loader-test-"));
	onTestFinished(() => {
		fs.rmSync(temporaryDirectory, { force: true, recursive: true });
	});
	return temporaryDirectory;
}

describe(loadRojoProject, () => {
	it("should load and parse a valid Rojo project", () => {
		expect.assertions(2);

		const temporaryDirectory = createTemporaryDirectory();

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

		const project = loadRojoProject(projectPath);

		expect(project.name).toBe("TestProject");
		expect(project.tree).toStrictEqual({
			$className: "DataModel",
			ReplicatedStorage: {
				shared: { $path: "src/shared" },
			},
		});
	});

	it("should resolve nested project references", () => {
		expect.assertions(1);

		const temporaryDirectory = createTemporaryDirectory();

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

		const project = loadRojoProject(projectPath);

		expect(project.tree["ReplicatedStorage"]).toStrictEqual({
			inner: { $path: "src/inner" },
		});
	});

	it("should preserve servePort when present", () => {
		expect.assertions(1);

		const temporaryDirectory = createTemporaryDirectory();

		const projectPath = path.join(temporaryDirectory, "default.project.json");
		fs.writeFileSync(
			projectPath,
			JSON.stringify({
				name: "TestProject",
				servePort: 34872,
				tree: { $className: "DataModel" },
			}),
		);

		const project = loadRojoProject(projectPath);

		expect(project.servePort).toBe(34872);
	});

	it("should not include servePort when absent", () => {
		expect.assertions(1);

		const temporaryDirectory = createTemporaryDirectory();

		const projectPath = path.join(temporaryDirectory, "default.project.json");
		fs.writeFileSync(
			projectPath,
			JSON.stringify({
				name: "TestProject",
				tree: { $className: "DataModel" },
			}),
		);

		const project = loadRojoProject(projectPath);

		expect(project.servePort).toBeUndefined();
	});

	it("should throw with file path when project has malformed JSON", () => {
		expect.assertions(1);

		const temporaryDirectory = createTemporaryDirectory();

		const projectPath = path.join(temporaryDirectory, "bad.project.json");
		fs.writeFileSync(projectPath, "not valid json {{{");

		expect(() => loadRojoProject(projectPath)).toThrow("Failed to parse Rojo project");
	});

	it("should throw when project JSON is not an object", () => {
		expect.assertions(1);

		const temporaryDirectory = createTemporaryDirectory();

		const projectPath = path.join(temporaryDirectory, "array.project.json");
		fs.writeFileSync(projectPath, JSON.stringify([1, 2, 3]));

		expect(() => loadRojoProject(projectPath)).toThrow("Rojo project must be a JSON object");
	});

	it("should throw when file does not exist", () => {
		expect.assertions(1);

		expect(() => loadRojoProject("/nonexistent/project.json")).toThrow(
			"Could not read Rojo project",
		);
	});

	it("should throw when name is missing", () => {
		expect.assertions(1);

		const temporaryDirectory = createTemporaryDirectory();

		const projectPath = path.join(temporaryDirectory, "bad.project.json");
		fs.writeFileSync(projectPath, JSON.stringify({ tree: { $className: "DataModel" } }));

		expect(() => loadRojoProject(projectPath)).toThrow(
			'Rojo project must have a non-empty "name" field',
		);
	});

	it("should throw when name is empty string", () => {
		expect.assertions(1);

		const temporaryDirectory = createTemporaryDirectory();

		const projectPath = path.join(temporaryDirectory, "bad.project.json");
		fs.writeFileSync(
			projectPath,
			JSON.stringify({ name: "", tree: { $className: "DataModel" } }),
		);

		expect(() => loadRojoProject(projectPath)).toThrow(
			'Rojo project must have a non-empty "name" field',
		);
	});

	it("should throw when tree is missing", () => {
		expect.assertions(1);

		const temporaryDirectory = createTemporaryDirectory();

		const projectPath = path.join(temporaryDirectory, "bad.project.json");
		fs.writeFileSync(projectPath, JSON.stringify({ name: "Bad" })!);

		expect(() => loadRojoProject(projectPath)).toThrow(
			'Rojo project must have a "tree" object',
		);
	});

	it("should throw when tree is an array", () => {
		expect.assertions(1);

		const temporaryDirectory = createTemporaryDirectory();

		const projectPath = path.join(temporaryDirectory, "bad.project.json");
		fs.writeFileSync(projectPath, JSON.stringify({ name: "Bad", tree: [] }));

		expect(() => loadRojoProject(projectPath)).toThrow(
			'Rojo project must have a "tree" object',
		);
	});

	it("should throw when tree is null", () => {
		expect.assertions(1);

		const temporaryDirectory = createTemporaryDirectory();

		const projectPath = path.join(temporaryDirectory, "bad.project.json");
		fs.writeFileSync(projectPath, JSON.stringify({ name: "Bad", tree: null }));

		expect(() => loadRojoProject(projectPath)).toThrow(
			'Rojo project must have a "tree" object',
		);
	});
});
