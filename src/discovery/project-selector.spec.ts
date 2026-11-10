import { fromAny } from "@total-typescript/shoehorn";

import { describe, expect, it } from "vitest";

import type { ProjectScope } from "../config/filter-projects-by-files.ts";
import { selectProjectScopes } from "./project-selector.ts";

function scopes(): Array<ProjectScope> {
	return ["client", "server"].map((displayName) => {
		return {
			project: fromAny({ displayName, include: [`src/${displayName}/**/*.spec.ts`] }),
			rootDirectory: "/repo/pkg",
		};
	});
}

describe(selectProjectScopes, () => {
	it("should preserve all scopes without filters", () => {
		expect.assertions(1);

		const all = scopes();

		expect(
			selectProjectScopes({
				fileBase: "/elsewhere",
				files: undefined,
				names: undefined,
				scopes: all,
			}),
		).toStrictEqual(all.map((scope) => ({ files: undefined, scope })));
	});

	it("should treat empty files as no file filter", () => {
		expect.assertions(1);

		const all = scopes();

		expect(
			selectProjectScopes({
				fileBase: "/elsewhere",
				files: [],
				names: ["client"],
				scopes: all,
			}),
		).toStrictEqual([{ files: undefined, scope: all[0]! }]);
	});

	it("should apply file filters after names and use the invocation base", () => {
		expect.assertions(1);

		const all = scopes();

		expect(
			selectProjectScopes({
				fileBase: "/repo",
				files: ["pkg/src/client/a.spec.ts", "pkg/src/server/b.spec.ts"],
				names: ["client"],
				scopes: all,
			}),
		).toStrictEqual([{ files: ["/repo/pkg/src/client/a.spec.ts"], scope: all[0]! }]);
	});

	it("should validate names before files", () => {
		expect.assertions(1);

		expect(() => {
			return selectProjectScopes({
				fileBase: "/repo",
				files: ["missing"],
				names: ["missing"],
				scopes: scopes(),
			});
		}).toThrow("Unknown project name(s): missing. Available: client, server");
	});

	it("should reject files belonging only to excluded scopes", () => {
		expect.assertions(1);

		expect(() => {
			return selectProjectScopes({
				fileBase: "/repo",
				files: ["pkg/src/server/a.spec.ts"],
				names: ["client"],
				scopes: scopes(),
			});
		}).toThrow("No project contains the requested file(s)");
	});

	it("should select nothing for an explicit empty name list", () => {
		expect.assertions(1);

		expect(
			selectProjectScopes({
				fileBase: "/repo",
				files: undefined,
				names: [],
				scopes: scopes(),
			}),
		).toStrictEqual([]);
	});
});
