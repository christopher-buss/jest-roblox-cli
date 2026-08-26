import { fromAny } from "@total-typescript/shoehorn";

import type { ResolvedConfig as C12ResolvedConfig, LoadConfigOptions } from "c12";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { loadRawConfig } from "./loader.ts";

vi.mock<typeof import("c12")>(import("c12"), async (importOriginal) => {
	const actual = await importOriginal();

	return {
		...actual,
		loadConfig: fromAny(vi.fn<(options: LoadConfigOptions) => Promise<C12ResolvedConfig>>()),
	};
});

async function mockEmptyConfig(): Promise<void> {
	const { loadConfig } = await import("c12");
	vi.mocked(loadConfig).mockResolvedValue({
		config: {},
		cwd: "/repo",
		layers: [],
	});
}

describe("c12 loader boundary", () => {
	it("should isolate implicit config discovery from ambient configuration sources", async () => {
		expect.assertions(3);

		await mockEmptyConfig();
		const { loadConfig } = await import("c12");
		const mockLoadConfig = vi.mocked(loadConfig);

		await expect(loadRawConfig(undefined, "/repo")).resolves.toStrictEqual({});

		const [options] = mockLoadConfig.mock.calls[0]!;
		const { merger, ...plainOptions } = options;

		expect(merger).toBeTypeOf("function");
		expect(plainOptions).toStrictEqual({
			name: "jest",
			configFileRequired: false,
			cwd: "/repo",
			dotenv: false,
			extend: false,
			globalRc: false,
			omit$Keys: true,
			packageJson: false,
			rcFile: false,
		});
	});

	it("should require and name an explicitly requested config file", async () => {
		expect.assertions(2);

		await mockEmptyConfig();
		const { loadConfig } = await import("c12");
		const mockLoadConfig = vi.mocked(loadConfig);

		await loadRawConfig("configs/jest.config.ts", "/repo");

		const [options] = mockLoadConfig.mock.calls[0]!;
		const { merger, ...plainOptions } = options;

		expect(merger).toBeTypeOf("function");
		expect(plainOptions).toStrictEqual({
			name: "jest",
			configFile: "configs/jest.config.ts",
			configFileRequired: true,
			cwd: "/repo",
			dotenv: false,
			extend: false,
			globalRc: false,
			omit$Keys: true,
			packageJson: false,
			rcFile: false,
		});
	});

	it("should provide the filesystem importer only in SEA mode", async () => {
		expect.assertions(3);

		await mockEmptyConfig();
		onTestFinished(() => {
			vi.unstubAllEnvs();
		});
		vi.stubEnv("JEST_ROBLOX_SEA", "true");
		const { loadConfig } = await import("c12");
		const mockLoadConfig = vi.mocked(loadConfig);

		await loadRawConfig("jest.config.json", "/repo");

		const [options] = mockLoadConfig.mock.calls[0]!;
		const { import: importConfig, merger, ...plainOptions } = options;

		expect(importConfig).toBeTypeOf("function");
		expect(merger).toBeTypeOf("function");
		expect(plainOptions).toStrictEqual({
			name: "jest",
			configFile: "jest.config.json",
			configFileRequired: true,
			cwd: "/repo",
			dotenv: false,
			extend: false,
			globalRc: false,
			omit$Keys: true,
			packageJson: false,
			rcFile: false,
		});
	});
});
