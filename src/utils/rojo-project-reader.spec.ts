import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { nodeRojoResolverFactory } from "./rojo-project-reader.ts";

const FIXTURE = path.resolve(import.meta.dirname, "../../test/fixtures/default.project.json");

describe(nodeRojoResolverFactory, () => {
	it("should resolve a Rojo project from disk", () => {
		expect.assertions(1);

		const resolver = nodeRojoResolverFactory(FIXTURE);

		expect(resolver.getPartitions().length).toBeGreaterThan(0);
	});
});
