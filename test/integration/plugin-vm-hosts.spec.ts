import { type } from "arktype";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { VM_HOST_POOL_SIZE } from "#src/protocol/studio.ts";

const nodeSchema = type({ "$className?": "string" }).or("string");

const pluginProject = type({ tree: { vmHosts: { "[string]": nodeSchema } } }).assert(
	JSON.parse(
		readFileSync(path.resolve(__dirname, "..", "..", "plugin", "plugin.project.json"), "utf8"),
	),
);

function isActor(node: typeof nodeSchema.infer): boolean {
	return typeof node === "object" && node.$className === "Actor";
}

describe("plugin VM hosts", () => {
	it("should build as many host Actors as VM_HOST_POOL_SIZE", () => {
		expect.assertions(1);

		const actors = Object.values(pluginProject.tree.vmHosts).filter(isActor);

		expect(actors).toHaveLength(VM_HOST_POOL_SIZE);
	});
});
