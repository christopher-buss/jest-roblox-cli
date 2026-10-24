import buffer from "node:buffer";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createPlacePayload, readPlaceFile } from "./file-system.ts";

describe("place file adapter", () => {
	it("should read a file as raw bytes", () => {
		expect.assertions(1);

		expect(readPlaceFile(import.meta.filename)).toBeInstanceOf(buffer.Buffer);
	});

	it.for([
		{ name: "game.RBXLX", format: "rbxlx" },
		{ name: "game.rbxl", format: "rbxl" },
		{ name: "game.other", format: "rbxl" },
	] satisfies Array<{ format: "rbxl" | "rbxlx"; name: string }>)(
		"should resolve the path and copy binary bytes using $format",
		({ name, format }) => {
			expect.assertions(3);

			const data = buffer.Buffer.from([1, 2, 255]);
			const readFile = vi.fn<(filePath: string) => buffer.Buffer>(() => data);
			const payload = createPlacePayload({ placeFilePath: name, readFile });

			expect(payload).toStrictEqual({
				body: new Uint8Array([1, 2, 255]),
				filePath: path.resolve(name),
				format,
			});
			expect(readFile).toHaveBeenCalledExactlyOnceWith(path.resolve(name));

			data[0] = 9;

			expect(payload.body[0]).toBe(1);
		},
	);
});
