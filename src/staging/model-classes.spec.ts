// cspell:ignore SSTR
import { Buffer } from "node:buffer";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";

import { buildWithRojo } from "../utils/rojo-builder.ts";
import { isModelFile, readDeclaredClasses } from "./model-classes.ts";

const FIXTURES = path.join(import.meta.dirname, "__fixtures__/pinned");

/**
 * Modules the built model carries. Enough of them that the writer's LZ4 stream
 * for the `INST` chunk — the one the class reader decodes — has to emit
 * back-references rather than one run of literals, which is the half of the
 * decoder a smaller model would leave untested. Eight is the measured floor:
 * at two modules rojo's `INST` chunks compress larger than they store, meaning
 * literal-only streams.
 */
const MODULE_COUNT = 8;

function rojoOnPath(): boolean {
	try {
		cp.execFileSync("rojo", ["--version"], { stdio: "pipe", windowsHide: true });
		return true;
	} catch {
		return false;
	}
}

function temporaryDirectory(): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "model-classes-"));
	onTestFinished(() => {
		fs.rmSync(directory, { force: true, recursive: true });
	});

	return directory;
}

/**
 * A binary model built the way rojo really writes one, so its chunks carry LZ4
 * the way the reader meets them in the wild rather than the way a hand-built
 * buffer would.
 *
 * Built here rather than committed because a `.rbxm` never reaches the public
 * mirror — sync.sh drops the suffix along with the built plugin — so a fixture
 * that ships as bytes reads as an empty class table upstream and passes here.
 * @param rootClass - Class the project pins its root to.
 * @returns Path to the built model.
 */
function buildModel(rootClass: string): string {
	const directory = temporaryDirectory();
	const sourceDirectory = path.join(directory, "many");
	fs.mkdirSync(sourceDirectory);
	for (let index = 1; index <= MODULE_COUNT; index += 1) {
		fs.writeFileSync(path.join(sourceDirectory, `mod${index}.luau`), `return ${index}\n`);
	}

	const projectPath = path.join(directory, "model.project.json");
	fs.writeFileSync(
		projectPath,
		JSON.stringify({
			name: "pinned",
			tree: {
				$className: rootClass,
				many: { $className: "Folder", $path: "many" },
			},
		}),
	);

	const modelPath = path.join(directory, "model.rbxm");
	buildWithRojo(projectPath, modelPath);
	return modelPath;
}

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

function writeTemporary(name: string, contents: Buffer | string): string {
	const filePath = path.join(temporaryDirectory(), name);
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
	it.skipIf(!rojoOnPath())(
		"should read every class out of a binary model, LZ4 chunks included",
		// A real rojo spawn, so the suite-wide per-test budget cannot hold it.
		{ timeout: 5000 },
		() => {
			expect.assertions(1);

			expect(readDeclaredClasses(buildModel("StarterPlayerScripts"))).toStrictEqual(
				expect.arrayContaining(["Folder", "ModuleScript", "StarterPlayerScripts"]),
			);
		},
	);

	it("should read every class out of an XML model", () => {
		expect.assertions(1);

		expect(readDeclaredClasses(path.join(FIXTURES, "service-root.rbxmx"))).toStrictEqual(
			expect.arrayContaining(["ModuleScript", "StarterPlayerScripts"]),
		);
	});

	it("should accept repeated whitespace before an XML class attribute", () => {
		expect.assertions(1);

		expect(
			readDeclaredClasses(
				writeTemporary("a.rbxmx", '<roblox><Item   class="Folder" /></roblox>'),
			),
		).toStrictEqual(["Folder"]);
	});

	it("should report no pinned class for a model that declares none", () => {
		expect.assertions(1);

		const model = Buffer.concat([binaryHeader(), chunk("INST", instancePayload("Folder"))]);

		expect(readDeclaredClasses(writeTemporary("a.rbxm", model))).toStrictEqual(["Folder"]);
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

		const model = Buffer.concat([
			Buffer.alloc(32),
			chunk("INST", instancePayload("MustNotBeRead")),
		]);

		expect(readDeclaredClasses(writeTemporary("a.rbxm", model))).toStrictEqual([]);
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

	it("should decode a compressed chunk whose literal length uses an extension", () => {
		expect.assertions(1);

		const payload = instancePayload("Workspace");
		const compressed = Buffer.concat([Buffer.from([0xf0, payload.length - 15]), payload]);
		const model = Buffer.concat([
			binaryHeader(),
			compressedChunk({ name: "INST", compressed, decompressedBytes: payload.length }),
		]);

		expect(readDeclaredClasses(writeTemporary("a.rbxm", model))).toStrictEqual(["Workspace"]);
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

			expect(readDeclaredClasses(writeTemporary("a.rbxm", model))).toStrictEqual([declared]);
		},
	);

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
