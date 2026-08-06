import { type, type Type } from "arktype";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { relativizeProjectPaths } from "./relativize-paths.ts";

const PROJECT_DIR = path.resolve("/repo/.jest-roblox/workspace");
const OUT_DIR = path.resolve("/repo/out/client");

// A rojo project is keyed by instance names the fixture dictates, so it is read
// through one schema rather than an assertion per test.
const projectSchema: Type<Record<string, unknown>> = type({
	"[string]": "unknown",
}).as<Record<string, unknown>>();

function parse(json: string): Record<string, unknown> {
	return projectSchema.assert(JSON.parse(json));
}

describe(relativizeProjectPaths, () => {
	it("should express an absolute $path relative to the project directory", () => {
		expect.assertions(1);

		const result = parse(
			relativizeProjectPaths(JSON.stringify({ tree: { $path: OUT_DIR } }), PROJECT_DIR),
		);

		expect(result["tree"]).toStrictEqual({ $path: "../../out/client" });
	});

	it("should rewrite $path entries at every depth", () => {
		expect.assertions(1);

		const result = parse(
			relativizeProjectPaths(
				JSON.stringify({
					tree: {
						ServerStorage: {
							__pkg_stage: { foo: { ReplicatedStorage: { $path: OUT_DIR } } },
						},
					},
				}),
				PROJECT_DIR,
			),
		);

		expect(result).toStrictEqual({
			tree: {
				ServerStorage: {
					__pkg_stage: { foo: { ReplicatedStorage: { $path: "../../out/client" } } },
				},
			},
		});
	});

	it("should leave a $path that is already relative alone", () => {
		expect.assertions(1);

		const result = parse(
			relativizeProjectPaths(JSON.stringify({ tree: { $path: "src" } }), PROJECT_DIR),
		);

		expect(result["tree"]).toStrictEqual({ $path: "src" });
	});

	it("should leave a non-string $path alone", () => {
		expect.assertions(1);

		const result = parse(
			relativizeProjectPaths(JSON.stringify({ tree: { $path: 42 } }), PROJECT_DIR),
		);

		expect(result["tree"]).toStrictEqual({ $path: 42 });
	});

	it("should carry non-path fields through untouched", () => {
		expect.assertions(1);

		const result = parse(
			relativizeProjectPaths(
				JSON.stringify({
					name: "jest-roblox-workspace",
					globIgnorePaths: ["**/tsconfig.json"],
					tree: { $className: "DataModel", $properties: { StreamingEnabled: true } },
				}),
				PROJECT_DIR,
			),
		);

		expect(result).toStrictEqual({
			name: "jest-roblox-workspace",
			globIgnorePaths: ["**/tsconfig.json"],
			tree: { $className: "DataModel", $properties: { StreamingEnabled: true } },
		});
	});

	it("should carry a null member through untouched", () => {
		expect.assertions(1);

		const result = parse(
			relativizeProjectPaths(JSON.stringify({ tree: { child: null } }), PROJECT_DIR),
		);

		expect(result["tree"]).toStrictEqual({ child: null });
	});
});
