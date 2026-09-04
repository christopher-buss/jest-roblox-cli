import { type } from "arktype";
import { Buffer } from "node:buffer";
import { assert, describe, expect, it } from "vitest";

import {
	buildIstanbulHtmlAssetsModule,
	ISTANBUL_HTML_ASSETS_ID,
} from "../loaders/istanbul-html-assets.mjs";

const builtAssetsSchema = type({
	"html": type({ "name": "string", "base64?": "string", "text?": "string" }).array(),
	"html-spa": type({ "name": "string", "base64?": "string", "text?": "string" }).array(),
});

type BuiltAssets = typeof builtAssetsSchema.infer;

/**
 * The emitted module, evaluated the way a loader's consumer would see it. It is
 * a single `export default` of a JSON literal, so stripping that prefix leaves
 * something `JSON.parse` reads.
 */
function buildAssets(): BuiltAssets {
	const source = buildIstanbulHtmlAssetsModule();
	const literal = source.replace(/^export default /, "").replace(/;\n?$/, "");
	return builtAssetsSchema.assert(JSON.parse(literal));
}

function findAsset(
	assets: BuiltAssets,
	group: keyof BuiltAssets,
	name: string,
): BuiltAssets["html"][number] {
	const asset = assets[group].find((entry) => entry.name === name);
	assert(asset !== undefined, `${group} carries no ${name}`);
	return asset;
}

function decodeAsset(asset: BuiltAssets["html"][number]): Buffer {
	assert(asset.base64 !== undefined, `${asset.name} carries no bytes`);
	return Buffer.from(asset.base64, "base64");
}

describe("istanbul html assets module", () => {
	it("should be named for the specifier the source imports", () => {
		expect.assertions(1);

		expect(ISTANBUL_HTML_ASSETS_ID).toBe("virtual:istanbul-html-assets");
	});

	it("should carry the html reporter's own assets and its vendor directory", () => {
		expect.assertions(2);

		const assets = buildAssets();
		const names = assets.html.map((asset) => asset.name);

		expect(names).toContain("base.css");
		// istanbul copies `vendor/` into the same report directory, so the two
		// arrive as one flat list rather than a nested one.
		expect(names).toContain("prettify.js");
	});

	it("should carry text as text and bytes as base64", () => {
		expect.assertions(2);

		const assets = buildAssets();

		expect(findAsset(assets, "html", "base.css").text).toContain("body");

		// The png decodes back to its magic bytes, so the base64 it travels as
		// is the file rather than a mangled utf-8 read of it.
		const favicon = decodeAsset(findAsset(assets, "html", "favicon.png"));

		expect(favicon.subarray(0, 4).toString("hex")).toBe("89504e47");
	});

	it("should carry the html-spa bundle", () => {
		expect.assertions(1);

		const assets = buildAssets();
		const names = assets["html-spa"].map((asset) => asset.name);

		expect(names).toContain("bundle.js");
	});
});
