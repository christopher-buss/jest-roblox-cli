// cspell:ignore SSTR
import { Buffer } from "node:buffer";
import * as path from "node:path";
import { assert, describe, expect, it, vi } from "vitest";

import compressedModel from "#test/fixtures/model-classes/rojo-compressed.json" with { type: "json" };
import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { isModelFile, readDeclaredClasses } from "./model-classes.ts";

const FIXTURES = path.join(import.meta.dirname, "__fixtures__/pinned");

/**
 * `<roblox!` plus signature, version, class count, instance count, reserved.
 */
function binaryHeader(): Buffer {
	const header = Buffer.alloc(32);
	header.write("<roblox!", 0, "ascii");
	Buffer.from([0x89, 0xff, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 8);
	return header;
}

/**
 * One uncompressed chunk: name, compressed length 0, stored length, reserved.
 */
function chunk(name: string, payload: Buffer): Buffer {
	const header = Buffer.alloc(16);
	header.write(name, 0, "ascii");
	header.writeUInt32LE(0, 4);
	header.writeUInt32LE(payload.length, 8);
	return Buffer.concat([header, payload]);
}

/** One compressed chunk with separate stored and decompressed lengths. */
function compressedChunk({
	name,
	compressed,
	decompressedBytes,
}: {
	compressed: Buffer;
	decompressedBytes: number;
	name: string;
}): Buffer {
	const header = Buffer.alloc(16);
	header.write(name, 0, "ascii");
	header.writeUInt32LE(compressed.length, 4);
	header.writeUInt32LE(decompressedBytes, 8);
	return Buffer.concat([header, compressed]);
}

/** An `INST` payload: class id, then the length-prefixed class name. */
function instancePayload(rootClass: string): Buffer {
	const name = Buffer.from(rootClass, "utf-8");
	const payload = Buffer.alloc(8 + name.length);
	payload.writeUInt32LE(0, 0);
	payload.writeUInt32LE(name.length, 4);
	name.copy(payload, 8);
	return payload;
}

/**
 * LZ4 for a class name made only of `A`, using an overlapping back-reference.
 */
function repeatedClassLz4(length: number): Buffer {
	const payload = instancePayload("A".repeat(length));
	const literals = payload.subarray(0, 9);
	const matchLength = length - 1;
	const shortLength = Math.min(matchLength - 4, 15);
	const extension: Array<number> = [];
	let remaining = matchLength - 19;
	while (remaining >= 255) {
		extension.push(255);
		remaining -= 255;
	}

	if (shortLength === 15) {
		extension.push(remaining);
	}

	return Buffer.concat([
		Buffer.from([(literals.length << 4) | shortLength]),
		literals,
		Buffer.from([1, 0, ...extension]),
	]);
}

function memoryFile(
	name: string,
	contents: Buffer | string,
): Parameters<typeof readDeclaredClasses> {
	const filePath = path.resolve("models", name);
	const { fileSystem } = createMemoryFileSystem();
	fileSystem.mkdirSync(path.dirname(filePath), { recursive: true });
	fileSystem.writeFileSync(filePath, contents);
	return [filePath, fileSystem];
}

describe(isModelFile, () => {
	it.for([
		["model.rbxm", true],
		["Model.RBXMX", true],
		["thing.model.json", true],
		["init.meta.json", true],
		["init.luau", false],
		["data.json", false],
	] as const)("should report %s as %s", ([fileName, expected]) => {
		expect.assertions(1);

		expect(isModelFile(fileName)).toBe(expected);
	});
});

describe(readDeclaredClasses, () => {
	it.for([
		{
			classes: ["Folder"],
			kind: "valid",
			model: Buffer.concat([binaryHeader(), chunk("INST", instancePayload("Folder"))]),
		},
		{ classes: [], kind: "malformed", model: Buffer.alloc(8) },
	])("should close the file after reading a $kind binary", ({ classes, model }) => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();
		volume.writeFileSync("/model.rbxm", model);
		const opened = vi.spyOn(fileSystem, "openSync");

		expect(readDeclaredClasses("/model.rbxm", fileSystem)).toStrictEqual(classes);

		const handle: unknown = opened.mock.results[0]!.value;
		assert(typeof handle === "number");

		expect(() => fileSystem.readSync(handle, Buffer.alloc(1), 0, 1, 0)).toThrow("EBADF");
	});

	it("should report no classes when the file ends before its first chunk", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();
		volume.writeFileSync("/empty.rbxm", binaryHeader());

		expect(readDeclaredClasses("/empty.rbxm", fileSystem)).toStrictEqual([]);
	});

	it("should read every class out of an XML model", () => {
		expect.assertions(1);

		expect(readDeclaredClasses(path.join(FIXTURES, "service-root.rbxmx"))).toStrictEqual(
			expect.arrayContaining(["ModuleScript", "StarterPlayerScripts"]),
		);
	});

	it("should read every class out of a binary model, LZ4 chunks included", () => {
		expect.assertions(1);

		const model = Buffer.from(compressedModel.base64, "base64");

		expect(readDeclaredClasses(...memoryFile("rojo.rbxm", model))).toStrictEqual(
			expect.arrayContaining(["Folder", "ModuleScript", "StarterPlayerScripts"]),
		);
	});

	it("should accept repeated whitespace before an XML class attribute", () => {
		expect.assertions(1);

		expect(
			readDeclaredClasses(
				...memoryFile("a.rbxmx", '<roblox><Item   class="Folder" /></roblox>'),
			),
		).toStrictEqual(["Folder"]);
	});

	it("should report no pinned class for a model that declares none", () => {
		expect.assertions(1);

		const model = Buffer.concat([binaryHeader(), chunk("INST", instancePayload("Folder"))]);

		expect(readDeclaredClasses(...memoryFile("a.rbxm", model))).toStrictEqual(["Folder"]);
	});

	it("should read ClassName out of a .model.json", () => {
		expect.assertions(1);

		expect(readDeclaredClasses(path.join(FIXTURES, "service.model.json"))).toStrictEqual([
			"StarterPlayerScripts",
		]);
	});

	it("should read className out of an init.meta.json", () => {
		expect.assertions(1);

		expect(
			readDeclaredClasses(path.join(FIXTURES, "meta/StarterPlayerScripts/init.meta.json")),
		).toStrictEqual(["StarterPlayerScripts"]);
	});

	it("should report nothing for a JSON descriptor that names no class", () => {
		expect.assertions(1);

		expect(
			readDeclaredClasses(...memoryFile("a.model.json", '{"Properties":{}}')),
		).toStrictEqual([]);
	});

	it.for(["null", "[]"] as const)(
		"should report nothing for a JSON descriptor of %s, which names no class",
		(contents) => {
			expect.assertions(1);

			expect(readDeclaredClasses(...memoryFile("a.model.json", contents))).toStrictEqual([]);
		},
	);

	it("should report nothing for a file extension that declares no class", () => {
		expect.assertions(1);

		expect(readDeclaredClasses(...memoryFile("init.luau", "return {}"))).toStrictEqual([]);
	});

	it("should report nothing for a malformed file rather than throwing", () => {
		expect.assertions(1);

		// rojo reads the same bytes moments later, and its error says far more
		// about what is wrong than a second parser's would.
		expect(readDeclaredClasses(...memoryFile("a.model.json", "{not json"))).toStrictEqual([]);
	});

	it("should report nothing for a binary file too short to hold a header", () => {
		expect.assertions(1);

		expect(readDeclaredClasses(...memoryFile("a.rbxm", Buffer.alloc(8)))).toStrictEqual([]);
	});

	it("should report nothing for a file whose magic is not the binary format", () => {
		expect.assertions(1);

		const model = Buffer.concat([
			Buffer.alloc(32),
			chunk("INST", instancePayload("MustNotBeRead")),
		]);

		expect(readDeclaredClasses(...memoryFile("a.rbxm", model))).toStrictEqual([]);
	});

	it("should skip the chunks that precede the class table", () => {
		expect.assertions(1);

		const model = Buffer.concat([
			binaryHeader(),
			chunk("META", Buffer.alloc(4)),
			chunk("SSTR", Buffer.alloc(4)),
			chunk("INST", instancePayload("Terrain")),
		]);

		expect(readDeclaredClasses(...memoryFile("a.rbxm", model))).toStrictEqual(["Terrain"]);
	});

	it("should decode a compressed chunk whose literal length uses an extension", () => {
		expect.assertions(1);

		const payload = instancePayload("Workspace");
		const compressed = Buffer.concat([Buffer.from([0xf0, payload.length - 15]), payload]);
		const model = Buffer.concat([
			binaryHeader(),
			compressedChunk({ name: "INST", compressed, decompressedBytes: payload.length }),
		]);

		expect(readDeclaredClasses(...memoryFile("a.rbxm", model))).toStrictEqual(["Workspace"]);
	});

	it.for([8, 20, 275] as const)(
		"should decode an overlapping LZ4 match for a %i-byte class name",
		(length) => {
			expect.assertions(1);

			const declared = "A".repeat(length);
			const model = Buffer.concat([
				binaryHeader(),
				compressedChunk({
					name: "INST",
					compressed: repeatedClassLz4(length),
					decompressedBytes: 8 + length,
				}),
			]);

			expect(readDeclaredClasses(...memoryFile("a.rbxm", model))).toStrictEqual([declared]);
		},
	);

	it("should reject compressed data that ends before its declared output length", () => {
		expect.assertions(1);

		const declared = "A".repeat(8);
		const model = Buffer.concat([
			binaryHeader(),
			compressedChunk({
				name: "INST",
				compressed: repeatedClassLz4(declared.length),
				decompressedBytes: instancePayload(declared).length + 1,
			}),
		]);

		expect(readDeclaredClasses(...memoryFile("a.rbxm", model))).toStrictEqual([]);
	});

	it("should reject compressed data that continues past its declared output length", () => {
		expect.assertions(1);

		const declared = "A".repeat(8);
		const compressed = Buffer.concat([
			repeatedClassLz4(declared.length),
			Buffer.from([0, 1, 0]),
		]);
		const model = Buffer.concat([
			binaryHeader(),
			compressedChunk({
				name: "INST",
				compressed,
				decompressedBytes: instancePayload(declared).length,
			}),
		]);

		expect(readDeclaredClasses(...memoryFile("a.rbxm", model))).toStrictEqual([]);
	});

	it("should stop at the first chunk after the class table", () => {
		expect.assertions(1);

		// Everything past `PROP` is property data — the bulk of a game-sized
		// model — and none of it names a class.
		const model = Buffer.concat([
			binaryHeader(),
			chunk("INST", instancePayload("Workspace")),
			chunk("PROP", Buffer.alloc(4096)),
			chunk("INST", instancePayload("NeverRead")),
		]);

		expect(readDeclaredClasses(...memoryFile("a.rbxm", model))).toStrictEqual(["Workspace"]);
	});

	it("should stop at a chunk whose body is truncated", () => {
		expect.assertions(1);

		// The header claims more bytes than the file holds. Decompressing the
		// partly-zeroed buffer would yield an arbitrary class name rather than
		// simply a missing one.
		const truncated = Buffer.alloc(16);
		truncated.write("INST", 0, "ascii");
		truncated.writeUInt32LE(0, 4);
		truncated.writeUInt32LE(64, 8);

		const model = Buffer.concat([
			binaryHeader(),
			chunk("INST", instancePayload("Lighting")),
			truncated,
			Buffer.alloc(4),
		]);

		expect(readDeclaredClasses(...memoryFile("a.rbxm", model))).toStrictEqual(["Lighting"]);
	});

	it("should stop at a truncated chunk header", () => {
		expect.assertions(1);

		const model = Buffer.concat([
			binaryHeader(),
			chunk("INST", instancePayload("Lighting")),
			Buffer.alloc(4),
		]);

		expect(readDeclaredClasses(...memoryFile("a.rbxm", model))).toStrictEqual(["Lighting"]);
	});
});
