import { fromAny } from "@total-typescript/shoehorn";

import { describe, expect, it } from "vitest";

import type { ResolvedProjectConfig } from "../config/projects.ts";
import { applyProjectFilter, type PackageContext } from "./project-contexts.ts";

function makeProject(displayName: string): ResolvedProjectConfig {
	return fromAny({ displayName });
}

function makeContext(name: string, projects: Array<string>): PackageContext {
	return fromAny({
		info: { name },
		projects: projects.map(makeProject),
	});
}

describe(applyProjectFilter, () => {
	const noFilterCases: Array<Array<string> | undefined> = [undefined, []];

	it.for(noFilterCases)("should return the original contexts for filter %j", (filter) => {
		expect.assertions(1);

		const contexts = [makeContext("@halcyon/a", ["unit"]), makeContext("@halcyon/b", ["e2e"])];

		expect(applyProjectFilter(contexts, filter)).toBe(contexts);
	});

	it("should keep only requested projects and drop empty package contexts", () => {
		expect.assertions(2);

		const unit = makeProject("unit");
		const integration = makeProject("integration");
		const e2e = makeProject("e2e");
		const first: PackageContext = fromAny({
			info: { name: "@halcyon/a" },
			projects: [unit, integration],
		});
		const second: PackageContext = fromAny({
			info: { name: "@halcyon/b" },
			projects: [e2e],
		});

		const filtered = applyProjectFilter([first, second], ["integration"]);

		expect(filtered).toStrictEqual([{ ...first, projects: [integration] }]);
		expect(filtered[0]!.projects[0]).toBe(integration);
	});

	it("should report every unknown name and every available project", () => {
		expect.assertions(1);

		const contexts = [
			makeContext("@halcyon/a", ["unit", "integration"]),
			makeContext("@halcyon/b", ["e2e"]),
		];

		expect(() => applyProjectFilter(contexts, ["missing", "other"])).toThrow(
			"Unknown project name(s): missing, other. Available: unit, integration, e2e",
		);
	});
});
