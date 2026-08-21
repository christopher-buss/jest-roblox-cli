// cspell:ignore SSTR
import { Buffer } from "node:buffer";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";

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

/** An `INST` payload: class id, then the length-prefixed class name. */
function instancePayload(rootClass: string): Buffer {
	const name = Buffer.from(rootClass, "utf-8");
	const payload = Buffer.alloc(8 + name.length);
	payload.writeUInt32LE(0, 0);
	payload.writeUInt32LE(name.length, 4);
	name.copy(payload, 8);
	return payload;
}

function writeTemporary(name: string, contents: Buffer | string): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "model-classes-"));
	onTestFinished(() => {
		fs.rmSync(directory, { force: true, recursive: true });
	});

	const filePath = path.join(directory, name);
	fs.writeFileSync(filePath, contents);
	return filePath;
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
	it("should read every class out of a binary model, LZ4 chunks included", () => {
		expect.assertions(1);

		// A rojo-built fixture, so the chunks are compressed the way the writer
		// really emits them rather than the way a hand-built buffer would.
		expect(readDeclaredClasses(path.join(FIXTURES, "service-root.rbxm"))).toStrictEqual(
			expect.arrayContaining(["Folder", "ModuleScript", "StarterPlayerScripts"]),
		);
	});

	it("should read every class out of an XML model", () => {
		expect.assertions(1);

		expect(readDeclaredClasses(path.join(FIXTURES, "service-root.rbxmx"))).toStrictEqual(
			expect.arrayContaining(["ModuleScript", "StarterPlayerScripts"]),
		);
	});

	it("should report no pinned class for a model that declares none", () => {
		expect.assertions(1);

		expect(readDeclaredClasses(path.join(FIXTURES, "plain.rbxm"))).not.toContain(
			"StarterPlayerScripts",
		);
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
			readDeclaredClasses(writeTemporary("a.model.json", '{"Properties":{}}')),
		).toStrictEqual([]);
	});

	it.for(["null", "[]"] as const)(
		"should report nothing for a JSON descriptor of %s, which names no class",
		(contents) => {
			expect.assertions(1);

			expect(readDeclaredClasses(writeTemporary("a.model.json", contents))).toStrictEqual([]);
		},
	);

	it("should report nothing for a file extension that declares no class", () => {
		expect.assertions(1);

		expect(readDeclaredClasses(writeTemporary("init.luau", "return {}"))).toStrictEqual([]);
	});

	it("should report nothing for a malformed file rather than throwing", () => {
		expect.assertions(1);

		// rojo reads the same bytes moments later, and its error says far more
		// about what is wrong than a second parser's would.
		expect(readDeclaredClasses(writeTemporary("a.model.json", "{not json"))).toStrictEqual([]);
	});

	it("should report nothing for a binary file too short to hold a header", () => {
		expect.assertions(1);

		expect(readDeclaredClasses(writeTemporary("a.rbxm", Buffer.alloc(8)))).toStrictEqual([]);
	});

	it("should report nothing for a file whose magic is not the binary format", () => {
		expect.assertions(1);

		expect(readDeclaredClasses(writeTemporary("a.rbxm", Buffer.alloc(64)))).toStrictEqual([]);
	});

	it("should skip the chunks that precede the class table", () => {
		expect.assertions(1);

		const model = Buffer.concat([
			binaryHeader(),
			chunk("META", Buffer.alloc(4)),
			chunk("SSTR", Buffer.alloc(4)),
			chunk("INST", instancePayload("Terrain")),
		]);

		expect(readDeclaredClasses(writeTemporary("a.rbxm", model))).toStrictEqual(["Terrain"]);
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

		expect(readDeclaredClasses(writeTemporary("a.rbxm", model))).toStrictEqual(["Workspace"]);
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

		expect(readDeclaredClasses(writeTemporary("a.rbxm", model))).toStrictEqual(["Lighting"]);
	});

	it("should stop at a truncated chunk header", () => {
		expect.assertions(1);

		const model = Buffer.concat([
			binaryHeader(),
			chunk("INST", instancePayload("Lighting")),
			Buffer.alloc(4),
		]);

		expect(readDeclaredClasses(writeTemporary("a.rbxm", model))).toStrictEqual(["Lighting"]);
	});
});
