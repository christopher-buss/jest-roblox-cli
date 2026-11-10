import { fromAny } from "@total-typescript/shoehorn";

import { vi } from "vitest";

import type { RunSeams } from "#src/run/seams.ts";

export function createRunSeams(overrides: Partial<RunSeams> = {}): RunSeams {
	return {
		...coverageSeams(),
		childProcess: unexpectedChildProcess(),
		createSetupResolver: vi.fn<RunSeams["createSetupResolver"]>(
			unexpected("createSetupResolver"),
		),

		loadPackageConfig: vi.fn<RunSeams["loadPackageConfig"]>(unexpected("loadPackageConfig")),
		openBackend: vi.fn<RunSeams["openBackend"]>(unexpected("openBackend")),
		prepareCoverage: vi.fn<RunSeams["prepareCoverage"]>(unexpected("prepareCoverage")),
		prepareWorkspaceCoverage: vi.fn<RunSeams["prepareWorkspaceCoverage"]>(
			unexpected("prepareWorkspaceCoverage"),
		),
		resolveAllProjects: vi.fn<RunSeams["resolveAllProjects"]>(unexpected("resolveAllProjects")),
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

function unexpectedChildProcess(): RunSeams["childProcess"] {
	return fromAny({
		execFile: vi.fn<() => never>(unexpected("childProcess.execFile")),
		execFileSync: vi.fn<() => never>(unexpected("childProcess.execFileSync")),
		spawn: vi.fn<() => never>(unexpected("childProcess.spawn")),
	});
}

function coverageSeams(): Pick<RunSeams, "mapCoverage"> {
	return {
		mapCoverage: vi.fn<RunSeams["mapCoverage"]>(unexpected("mapCoverage")),
	};
}
