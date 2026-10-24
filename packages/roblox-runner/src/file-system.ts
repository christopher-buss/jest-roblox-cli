import type buffer from "node:buffer";
import fs from "node:fs";
import path from "node:path";

export const readPlaceFile: typeof fs.readFileSync = fs.readFileSync;

interface PlacePayloadInput {
	placeFilePath: string;
	readFile: (filePath: string) => buffer.Buffer;
}
interface PlacePayload {
	body: Uint8Array<ArrayBuffer>;
	filePath: string;
	format: "rbxl" | "rbxlx";
}

/**
 * Copy the binary payload into the `Uint8Array<ArrayBuffer>` the upload requires.
 * @param options - Place path and synchronous binary reader.
 * @returns Absolute path, extension-selected wire format and independent bytes.
 */
export function createPlacePayload({ placeFilePath, readFile }: PlacePayloadInput): PlacePayload {
	const filePath = path.resolve(placeFilePath);
	const data = readFile(filePath);
	const body = new Uint8Array(data.byteLength);
	body.set(data);
	return {
		body,
		filePath,
		format: path.extname(filePath).toLowerCase() === ".rbxlx" ? "rbxlx" : "rbxl",
	};
}
