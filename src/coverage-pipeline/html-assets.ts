/// <reference path="./istanbul-content-writer.d.ts" />
/// <reference path="./istanbul-modules.d.ts" />
import type { FileWriter } from "istanbul-lib-report";
import { Buffer } from "node:buffer";
import istanbulHtmlAssets from "virtual:istanbul-html-assets";

/** The reporters that write an asset directory beside their html. */
export type HtmlAssetGroup = keyof typeof istanbulHtmlAssets;

/**
 * What istanbul's html reporter prepends to each `.js` asset it copies, kept so
 * a report directory linted by its consumer reads the same either way.
 */
const JS_ASSET_HEADER = "/* eslint-disable */\n";

/**
 * Write one reporter's assets into the report directory, in place of the
 * `readdirSync` + `copyFile` pass that reads them from beside the reporter
 * module. Same files, same names, same order; they travel inside the bundle
 * rather than beside it (see `loaders/istanbul-html-assets.mjs`).
 */
export function writeIstanbulHtmlAssets(writer: FileWriter, group: HtmlAssetGroup): void {
	const assets = istanbulHtmlAssets[group];
	for (const asset of assets) {
		const content =
			"text" in asset
				? headerFor(asset.name) + asset.text
				: Buffer.from(asset.base64, "base64");

		const contentWriter = writer.writeFile(asset.name);
		contentWriter.write(content);
		contentWriter.close();
	}
}

function headerFor(name: string): string {
	return name.endsWith(".js") ? JS_ASSET_HEADER : "";
}
