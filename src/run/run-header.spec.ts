import process from "node:process";
import { describe, it, vi } from "vitest";

import { NOOP_PROGRESS } from "#test/mocks/noop-progress.ts";
import type { RunHeaderInput } from "./run-header.ts";
import { emitRunHeader } from "./run-header.ts";

function baseInput(overrides: Partial<RunHeaderInput> = {}): RunHeaderInput {
	return {
		color: false,
		formatters: ["default"],
		progress: NOOP_PROGRESS,
		rootDir: "/project",
		silent: false,
		verbose: false,
		version: "1.2.3",
		...overrides,
	};
}

describe(emitRunHeader, () => {
	it("should write the run header to stdout for the default human formatter", ({ expect }) => {
		expect.assertions(1);

		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		emitRunHeader(baseInput());

		expect(stdout).toHaveBeenCalledWith(expect.stringContaining(" RUN  v1.2.3 /project"));
	});

	it("should write the run header when no formatter is configured", ({ expect }) => {
		expect.assertions(1);

		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		emitRunHeader(baseInput({ formatters: undefined }));

		expect(stdout).toHaveBeenCalledWith(expect.stringContaining(" RUN  v1.2.3 /project"));
	});

	it("should emit nothing when silent", ({ expect }) => {
		expect.assertions(1);

		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		emitRunHeader(baseInput({ silent: true }));

		expect(stdout).not.toHaveBeenCalled();
	});

	it("should emit nothing for the json formatter", ({ expect }) => {
		expect.assertions(1);

		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		emitRunHeader(baseInput({ formatters: ["json"] }));

		expect(stdout).not.toHaveBeenCalled();
	});

	it("should emit nothing for the agent formatter", ({ expect }) => {
		expect.assertions(1);

		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		emitRunHeader(baseInput({ formatters: ["agent"] }));

		expect(stdout).not.toHaveBeenCalled();
	});

	it("should emit for the agent formatter when verbose (human path)", ({ expect }) => {
		expect.assertions(1);

		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		emitRunHeader(baseInput({ formatters: ["agent"], verbose: true }));

		expect(stdout).toHaveBeenCalledWith(expect.stringContaining(" RUN  v1.2.3 /project"));
	});

	it("should show the coverage subtitle when coverage is enabled", ({ expect }) => {
		expect.assertions(1);

		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		emitRunHeader(baseInput({ collectCoverage: true }));

		expect(stdout).toHaveBeenCalledWith(expect.stringContaining("Coverage enabled with"));
	});
});
