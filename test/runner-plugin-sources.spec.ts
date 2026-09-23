import { type } from "arktype";
import { describe, expect, it } from "vitest";

import {
	buildRunnerPluginSourcesModule,
	RUNNER_PLUGIN_SOURCES_ID,
} from "../loaders/runner-plugin-sources.mjs";

const sourcesSchema = type({ path: "string", text: "string" }).array();

function buildPaths(): Array<string> {
	const source = buildRunnerPluginSourcesModule();
	const literal = source.replace(/^export default /, "").replace(/;\n?$/, "");
	return sourcesSchema.assert(JSON.parse(literal)).map((file) => file.path);
}

describe("runner plugin sources module", () => {
	it("should be named for the specifier the source imports", () => {
		expect.assertions(1);

		expect(RUNNER_PLUGIN_SOURCES_ID).toBe("virtual:runner-plugin-sources");
	});

	it("should carry the plugin project, its run-mode runner, vm host, and shared luau tree", () => {
		expect.assertions(4);

		const paths = buildPaths();

		expect(paths).toContain("plugin/plugin.project.json");
		expect(paths).toContain("plugin/src/test-in-run-mode.server.luau");
		expect(paths).toContain("plugin/host/vm-host.server.luau");
		expect(paths).toContain("luau/staging/embedded-runner.luau");
	});

	it("should leave out the edit-mode client and the stamped version", () => {
		expect.assertions(2);

		const paths = buildPaths();

		expect(paths).not.toContain("plugin/src/init.server.luau");
		expect(paths).not.toContain("plugin/src/version.luau");
	});
});
