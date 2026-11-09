import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import type { FileSystem } from "../utils/file-system.ts";
import {
	ensureLuauConfigTypes,
	LUAU_CONFIG_TYPE_SOURCE,
	writeLuauConfigTypes,
} from "./luau-config-type.ts";

const HOME = path.resolve("/home/user");
const TYPE_MODULE = path.join(HOME, ".jest-roblox", "typedefs", "1.2.3", "config.luau");

describe("lUAU_CONFIG_TYPE_SOURCE", () => {
	it("should hold the Luau Config type", () => {
		expect.assertions(1);

		expect(LUAU_CONFIG_TYPE_SOURCE).toContain("export type Config =");
	});
});

describe(writeLuauConfigTypes, () => {
	it("should replace the type module in the versioned home folder", () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem({ [TYPE_MODULE]: "-- old" });

		const directory = writeLuauConfigTypes({
			fileSystem,
			homeDirectory: HOME,
			version: "1.2.3",
		});

		expect(directory).toBe(path.dirname(TYPE_MODULE));
		expect(volume.readFileSync(TYPE_MODULE, "utf-8")).toBe(LUAU_CONFIG_TYPE_SOURCE);
	});

	it("should move a whole file into place so a parallel run never reads part of it", () => {
		expect.assertions(3);

		const { fileSystem, volume } = createMemoryFileSystem();
		const written: Array<string> = [];
		const recording: FileSystem = {
			...fileSystem,
			writeFileSync: (file, data) => {
				written.push(String(file));
				fileSystem.writeFileSync(file, data);
			},
		};

		writeLuauConfigTypes({ fileSystem: recording, homeDirectory: HOME, version: "1.2.3" });

		expect(written).not.toContain(TYPE_MODULE);
		expect(volume.readFileSync(TYPE_MODULE, "utf-8")).toBe(LUAU_CONFIG_TYPE_SOURCE);
		expect(volume.readdirSync(path.dirname(TYPE_MODULE))).toStrictEqual(["config.luau"]);
	});
});

describe(ensureLuauConfigTypes, () => {
	it("should write the type module when it is missing", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		ensureLuauConfigTypes({ fileSystem, homeDirectory: HOME, version: "1.2.3" });

		expect(volume.readFileSync(TYPE_MODULE, "utf-8")).toBe(LUAU_CONFIG_TYPE_SOURCE);
	});

	it("should keep a type module that is already there", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem({ [TYPE_MODULE]: "-- kept" });

		ensureLuauConfigTypes({ fileSystem, homeDirectory: HOME, version: "1.2.3" });

		expect(volume.readFileSync(TYPE_MODULE, "utf-8")).toBe("-- kept");
	});

	it("should return no failure when it writes the type module", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

		expect(
			ensureLuauConfigTypes({ fileSystem, homeDirectory: HOME, version: "1.2.3" }),
		).toBeUndefined();
	});

	it("should return the failure when the home folder cannot be written", () => {
		expect.assertions(2);

		const denied = new Error("EACCES: permission denied");
		const { fileSystem } = createMemoryFileSystem();
		const readOnly: FileSystem = {
			...fileSystem,
			mkdirSync: () => {
				throw denied;
			},
		};

		const failure = ensureLuauConfigTypes({
			fileSystem: readOnly,
			homeDirectory: HOME,
			version: "1.2.3",
		});

		expect(failure).toHaveProperty(
			"message",
			`Could not write the Luau Config types to ${path.dirname(TYPE_MODULE)}: EACCES: permission denied`,
		);
		expect(failure).toHaveProperty("cause", denied);
	});
});
