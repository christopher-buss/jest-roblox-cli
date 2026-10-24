import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { captureError } from "#test/helpers/unit/errors";
import { makeFileSystem } from "#test/helpers/unit/file-system";
import { loadRojoProject } from "./loader.ts";

describe(loadRojoProject, () => {
	it("should reject invalid fields after loading a valid project", () => {
		expect.assertions(4);

		const { directory, fileSystem, fs } = makeFileSystem();
		const file = path.join(directory, "default.project.json");
		fs.writeFileSync(file, JSON.stringify({ name: "Game", tree: {} }));

		expect(loadRojoProject(file, fileSystem).name).toBe("Game");

		fs.writeFileSync(file, JSON.stringify({ tree: {} }));

		expect(() => loadRojoProject(file, fileSystem)).toThrow(/name must be/);

		fs.writeFileSync(file, JSON.stringify({ name: "Game", servePort: "bad", tree: {} }));

		expect(() => loadRojoProject(file, fileSystem)).toThrow(/servePort/);

		fs.writeFileSync(
			file,
			JSON.stringify({ name: "Game", tree: { $path: { optional: false } } }),
		);

		expect(() => loadRojoProject(file, fileSystem)).toThrow(/optional/);
	});

	it("should retain the host failure as the read error cause", () => {
		expect.assertions(1);

		const failure = new Error("unavailable");
		const { fileSystem } = makeFileSystem();
		fileSystem.readFileSync = () => {
			throw failure;
		};

		expect(() => loadRojoProject("project.json", fileSystem)).toThrow(
			expect.objectContaining({ cause: failure }),
		);
	});

	it("should retain malformed JSON as the parse error cause", () => {
		expect.assertions(1);

		const { directory, fileSystem } = makeFileSystem({ "broken.project.json": "{" });

		const error = captureError(() => {
			return loadRojoProject(path.join(directory, "broken.project.json"), fileSystem);
		});

		expect(error.cause).toBeInstanceOf(SyntaxError);
	});

	it("should load and parse a valid Rojo project", () => {
		expect.assertions(2);

		const { directory: temporaryDirectory, fileSystem, fs } = makeFileSystem();

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

		const project = loadRojoProject(projectPath, fileSystem);

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

		const { directory: temporaryDirectory, fileSystem, fs } = makeFileSystem();

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

		const project = loadRojoProject(projectPath, fileSystem);

		expect(project.tree["ReplicatedStorage"]).toStrictEqual({
			inner: { $path: "src/inner" },
		});
	});

	it("should preserve servePort when present", () => {
		expect.assertions(1);

		const { directory: temporaryDirectory, fileSystem, fs } = makeFileSystem();

		const projectPath = path.join(temporaryDirectory, "default.project.json");
		fs.writeFileSync(
			projectPath,
			JSON.stringify({
				name: "TestProject",
				servePort: 34872,
				tree: { $className: "DataModel" },
			}),
		);

		const project = loadRojoProject(projectPath, fileSystem);

		expect(project.servePort).toBe(34872);
	});

	it("should not include servePort when absent", () => {
		expect.assertions(1);

		const { directory: temporaryDirectory, fileSystem, fs } = makeFileSystem();

		const projectPath = path.join(temporaryDirectory, "default.project.json");
		fs.writeFileSync(
			projectPath,
			JSON.stringify({
				name: "TestProject",
				tree: { $className: "DataModel" },
			}),
		);

		const project = loadRojoProject(projectPath, fileSystem);

		expect(project.servePort).toBeUndefined();
	});

	it("should keep undeclared top-level keys on raw only", () => {
		expect.assertions(2);

		const { directory: temporaryDirectory, fileSystem, fs } = makeFileSystem();

		const projectPath = path.join(temporaryDirectory, "default.project.json");
		fs.writeFileSync(
			projectPath,
			JSON.stringify({
				name: "TestProject",
				gameId: 12345,
				tree: { $className: "DataModel" },
			}),
		);

		const project = loadRojoProject(projectPath, fileSystem);

		expect(Object.keys(project)).not.toContain("gameId");
		expect(project.raw["gameId"]).toBe(12345);
	});

	it("should throw when servePort is not a number", () => {
		expect.assertions(1);

		const { directory: temporaryDirectory, fileSystem, fs } = makeFileSystem();

		const projectPath = path.join(temporaryDirectory, "bad.project.json");
		fs.writeFileSync(
			projectPath,
			JSON.stringify({ name: "Bad", servePort: "34872", tree: { $className: "DataModel" } }),
		);

		expect(() => loadRojoProject(projectPath, fileSystem)).toThrow(
			/servePort must be a number/,
		);
	});

	it("should throw with file path when project has malformed JSON", () => {
		expect.assertions(1);

		const { directory: temporaryDirectory, fileSystem, fs } = makeFileSystem();

		const projectPath = path.join(temporaryDirectory, "bad.project.json");
		fs.writeFileSync(projectPath, "not valid json {{{");

		expect(() => loadRojoProject(projectPath, fileSystem)).toThrow(
			"Failed to parse Rojo project",
		);
	});

	it("should throw when project JSON is not an object", () => {
		expect.assertions(1);

		const { directory: temporaryDirectory, fileSystem, fs } = makeFileSystem();

		const projectPath = path.join(temporaryDirectory, "array.project.json");
		fs.writeFileSync(projectPath, JSON.stringify([1, 2, 3]));

		expect(() => loadRojoProject(projectPath, fileSystem)).toThrow(
			/Invalid Rojo project .*: must be an object .was an array./,
		);
	});

	it("should throw when file does not exist", () => {
		expect.assertions(1);

		const { fileSystem } = makeFileSystem();

		expect(() => loadRojoProject("/nonexistent/project.json", fileSystem)).toThrow(
			"Could not read Rojo project",
		);
	});

	it("should throw when name is missing", () => {
		expect.assertions(1);

		const { directory: temporaryDirectory, fileSystem, fs } = makeFileSystem();

		const projectPath = path.join(temporaryDirectory, "bad.project.json");
		fs.writeFileSync(projectPath, JSON.stringify({ tree: { $className: "DataModel" } }));

		expect(() => loadRojoProject(projectPath, fileSystem)).toThrow(
			/Invalid Rojo project .*: name must be/,
		);
	});

	it("should throw when name is empty string", () => {
		expect.assertions(1);

		const { directory: temporaryDirectory, fileSystem, fs } = makeFileSystem();

		const projectPath = path.join(temporaryDirectory, "bad.project.json");
		fs.writeFileSync(
			projectPath,
			JSON.stringify({ name: "", tree: { $className: "DataModel" } }),
		);

		expect(() => loadRojoProject(projectPath, fileSystem)).toThrow(
			/Invalid Rojo project .*: name must be/,
		);
	});

	it("should throw when tree is missing", () => {
		expect.assertions(1);

		const { directory: temporaryDirectory, fileSystem, fs } = makeFileSystem();

		const projectPath = path.join(temporaryDirectory, "bad.project.json");
		fs.writeFileSync(projectPath, JSON.stringify({ name: "Bad" })!);

		expect(() => loadRojoProject(projectPath, fileSystem)).toThrow(
			/Invalid Rojo project .*: tree must be an object/,
		);
	});

	it("should throw when tree is an array", () => {
		expect.assertions(1);

		const { directory: temporaryDirectory, fileSystem, fs } = makeFileSystem();

		const projectPath = path.join(temporaryDirectory, "bad.project.json");
		fs.writeFileSync(projectPath, JSON.stringify({ name: "Bad", tree: [] }));

		expect(() => loadRojoProject(projectPath, fileSystem)).toThrow(
			/Invalid Rojo project .*: tree must be an object/,
		);
	});

	it("should throw when tree is null", () => {
		expect.assertions(1);

		const { directory: temporaryDirectory, fileSystem, fs } = makeFileSystem();

		const projectPath = path.join(temporaryDirectory, "bad.project.json");
		fs.writeFileSync(projectPath, JSON.stringify({ name: "Bad", tree: null }));

		expect(() => loadRojoProject(projectPath, fileSystem)).toThrow(
			/Invalid Rojo project .*: tree must be an object/,
		);
	});
});
