import { fromAny } from "@total-typescript/shoehorn";

import { describe, expect, it } from "vitest";

import type { Config } from "./config-types.ts";
import type { FormatterEntry } from "./formatter-selection.ts";
import {
	assertConsensus,
	computeConsensus,
	type PackageConfigEntry,
	resolveField,
	resolveOptionalField,
} from "./workspace-consensus.ts";

const BACKEND = {
	name: "backend",
	readConfig: (config: Config) => config.backend,
};

const REQUIRED_BACKEND = {
	...BACKEND,
	default: "auto" as const,
	readCli: (cli: { backend?: Config["backend"] }) => cli.backend,
};

interface ConsensusErrorShape extends Error {
	readonly field: string;
	readonly groups: ReadonlyArray<{ packages: ReadonlyArray<string>; value: unknown }>;
	readonly omittedBy: ReadonlyArray<string>;
}

function packages(...backends: Array<Config["backend"]>): Array<PackageConfigEntry> {
	return backends.map((backend, index) => {
		return {
			name: ["alpha", "gamma", "beta", "delta"][index]!,
			config: backend === undefined ? {} : { backend },
		};
	});
}

function captureConsensusError(entries: ReadonlyArray<PackageConfigEntry>): ConsensusErrorShape {
	try {
		computeConsensus(entries, BACKEND);
	} catch (err) {
		if (err instanceof Error && err.name === "WorkspaceConsensusError") {
			return fromAny<ConsensusErrorShape, unknown>(err);
		}

		throw err;
	}

	throw new Error("expected a consensus conflict");
}

describe(computeConsensus, () => {
	it("should return the value every package agrees on", () => {
		expect.assertions(1);

		expect(computeConsensus(packages("studio", "studio"), BACKEND)).toBe("studio");
	});

	it("should treat deep-equal values as agreement", () => {
		expect.assertions(1);

		const spec = { name: "formatters", readConfig: (config: Config) => config.formatters };
		const entries = [
			{ name: "alpha", config: { formatters: ["json"] as Array<FormatterEntry> } },
			{ name: "beta", config: { formatters: ["json"] as Array<FormatterEntry> } },
		];

		expect(computeConsensus(entries, spec)).toStrictEqual(["json"]);
	});

	it("should be undefined when no package declares the field", () => {
		expect.assertions(1);

		expect(computeConsensus(packages(undefined, undefined), BACKEND)).toBeUndefined();
	});

	it("should list each declared value with the packages declaring it", () => {
		expect.assertions(5);

		const captured = captureConsensusError(packages("open-cloud", "open-cloud", "studio"));

		expect(captured.name).toBe("WorkspaceConsensusError");
		expect(captured.field).toBe("backend");
		expect(captured.groups).toStrictEqual([
			{ packages: ["alpha", "gamma"], value: "open-cloud" },
			{ packages: ["beta"], value: "studio" },
		]);
		expect(captured.omittedBy).toStrictEqual([]);
		expect(captured.message).toBe(
			[
				"workspace packages disagree on `backend`.",
				"",
				'  - "open-cloud" (declared by alpha, gamma)',
				'  - "studio" (declared by beta)',
				"",
				"In workspace mode this field must be uniform across all selected",
				"packages. The entire run uses one backend. Either:",
				"  - Declare it consistently across packages (typically by inheriting",
				"    from a shared config), OR",
				"  - Pass the CLI override to set a single value for the run.",
			].join("\n"),
		);
	});

	it("should use the partial-variant wording in the error message", () => {
		expect.assertions(3);

		const captured = captureConsensusError(
			packages("open-cloud", "open-cloud", undefined, undefined),
		);

		expect(captured.groups).toStrictEqual([
			{ packages: ["alpha", "gamma"], value: "open-cloud" },
		]);
		expect(captured.omittedBy).toStrictEqual(["beta", "delta"]);
		expect(captured.message).toBe(
			[
				"workspace packages disagree on `backend`.",
				"",
				'  - declared as "open-cloud" by: alpha, gamma',
				"  - not declared by: beta, delta",
				"",
				"In workspace mode this field must be uniform across all selected",
				"packages. The entire run uses one backend. Either:",
				"  - Declare it consistently across packages (typically by inheriting",
				"    from a shared config), OR",
				"  - Pass the CLI override to set a single value for the run.",
			].join("\n"),
		);
	});
});

describe(assertConsensus, () => {
	it("should pass when packages agree", () => {
		expect.assertions(1);

		expect(() => {
			assertConsensus(packages("studio", "studio"), BACKEND);
		}).not.toThrow();
	});

	it("should throw when packages disagree", () => {
		expect.assertions(1);

		expect(() => {
			assertConsensus(packages("studio", "open-cloud"), BACKEND);
		}).toThrow(expect.objectContaining({ name: "WorkspaceConsensusError" }));
	});
});

describe(resolveField, () => {
	it("should let the CLI value beat per-package disagreement", () => {
		expect.assertions(1);

		expect(
			resolveField({
				cli: { backend: "studio-cli" },
				perPackageConfigs: packages("studio", "open-cloud"),
				spec: REQUIRED_BACKEND,
			}),
		).toBe("studio-cli");
	});

	it("should use the per-package consensus", () => {
		expect.assertions(1);

		expect(
			resolveField({
				cli: {},
				perPackageConfigs: packages("studio"),
				spec: REQUIRED_BACKEND,
			}),
		).toBe("studio");
	});

	it("should fall back to the default when no package declares the field", () => {
		expect.assertions(1);

		expect(
			resolveField({
				cli: {},
				perPackageConfigs: packages(undefined),
				spec: REQUIRED_BACKEND,
			}),
		).toBe("auto");
	});
});

describe(resolveOptionalField, () => {
	it("should let the CLI value beat per-package disagreement", () => {
		expect.assertions(1);

		expect(
			resolveOptionalField({
				cli: { backend: "studio" },
				perPackageConfigs: packages("studio-cli", "open-cloud"),
				spec: REQUIRED_BACKEND,
			}),
		).toBe("studio");
	});

	it("should be undefined when no one declares the field", () => {
		expect.assertions(1);

		expect(
			resolveOptionalField({
				cli: {},
				perPackageConfigs: packages(undefined),
				spec: REQUIRED_BACKEND,
			}),
		).toBeUndefined();
	});
});
