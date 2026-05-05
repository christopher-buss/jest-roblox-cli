import type { ResolvedConfig } from "../config/schema.ts";
import template from "../materializer.bundled.luau";
import { buildJestArgv, type JestArgv } from "../test-script.ts";

export interface MaterializerInput {
	config: ResolvedConfig;
	pkg: string;
	project: string;
	testFiles: Array<string>;
}

interface EntryPayload {
	config: JestArgv;
	pkg: string;
	project: string;
}

export function generateMaterializerScript(inputs: Array<MaterializerInput>): string {
	const entries: Array<EntryPayload> = inputs.map((input) => {
		return {
			config: buildJestArgv({ config: input.config, testFiles: input.testFiles }),
			pkg: input.pkg,
			project: input.project,
		};
	});
	const payload = JSON.stringify({ entries });
	if (payload.includes("]==]")) {
		throw new Error("workspace materializer payload contains forbidden sequence ']==]'");
	}

	return template.replace("__CONFIG_JSON__", () => payload);
}
