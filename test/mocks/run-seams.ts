import { fromAny } from "@total-typescript/shoehorn";

import { vi } from "vitest";

import type { RunSeams } from "#src/run/seams.ts";

export function createRunSeams(overrides: Partial<RunSeams> = {}): RunSeams {
	return {
		childProcess: fromAny({
			execFile: vi.fn<() => never>(unexpected("childProcess.execFile")),
			execFileSync: vi.fn<() => never>(unexpected("childProcess.execFileSync")),
			spawn: vi.fn<() => never>(unexpected("childProcess.spawn")),
		}),
		createSetupResolver: vi.fn<RunSeams["createSetupResolver"]>(
			unexpected("createSetupResolver"),
		),
		prepareCoverage: vi.fn<RunSeams["prepareCoverage"]>(unexpected("prepareCoverage")),
		resolveAllProjects: vi.fn<RunSeams["resolveAllProjects"]>(unexpected("resolveAllProjects")),
		resolveBackend: vi.fn<RunSeams["resolveBackend"]>(unexpected("resolveBackend")),
		runProjects: vi.fn<RunSeams["runProjects"]>(unexpected("runProjects")),
		runTypecheck: vi.fn<RunSeams["runTypecheck"]>(unexpected("runTypecheck")),
		tsconfigReader: vi.fn<RunSeams["tsconfigReader"]>(unexpected("tsconfigReader")),
		...overrides,
	};
}

function unexpected(member: string): () => never {
	return () => {
		throw new Error(`unexpected RunSeams.${member} call`);
	};
}
