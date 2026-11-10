/// <reference path="./istanbul-content-writer.d.ts" />
/// <reference path="./istanbul-modules.d.ts" />
import type { FileWriter } from "istanbul-lib-report";
import { Buffer } from "node:buffer";
import istanbulHtmlAssets from "virtual:istanbul-html-assets";

/** The reporters that write an asset directory beside their html. */
export type HtmlAssetGroup = keyof typeof istanbulHtmlAssets;

const JS_ASSET_HEADER = "/* eslint-disable */\n";

/**
 * Write one reporter's assets into the report directory.
 * Assets come from `loaders/istanbul-html-assets.mjs`.
 * @param writer - Writes into the report directory.
 * @param group - Reporter whose assets to write.
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
