import type { ResolvedConfig } from "../config/schema.ts";
import template from "../materializer.bundled.luau";
import { buildJestArgv, type JestArgv } from "../test-script.ts";

export interface MaterializerInput {
	name: string;
	config: ResolvedConfig;
	testFiles: Array<string>;
}

interface PackagePayload {
	config: JestArgv;
	pkg: string;
}

export function generateMaterializerScript(inputs: Array<MaterializerInput>): string {
	const packages: Array<PackagePayload> = inputs.map((input) => {
		return {
			config: buildJestArgv({ config: input.config, testFiles: input.testFiles }),
			pkg: input.name,
		};
	});
	const payload = JSON.stringify({ packages });
	if (payload.includes("]==]")) {
		throw new Error("workspace materializer payload contains forbidden sequence ']==]'");
	}

	return template.replace("__CONFIG_JSON__", () => payload);
}
