import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import istanbulHtmlAssets from "virtual:istanbul-html-assets";
import { describe, expect, it } from "vitest";

type HtmlAssetGroup = keyof typeof istanbulHtmlAssets;

const ASSET_SOURCE_DIRECTORIES: Record<HtmlAssetGroup, Array<string>> = {
	"html": ["lib/html/assets", "lib/html/assets/vendor"],
	"html-spa": ["lib/html-spa/assets"],
};

function istanbulReportsRoot(): string {
	const require = createRequire(import.meta.url);
	return path.dirname(require.resolve("istanbul-reports/package.json"));
}

function digest(content: Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

function digestSourceAssets(group: HtmlAssetGroup): Map<string, string> {
	const root = istanbulReportsRoot();
	const digests = new Map<string, string>();

	const directories = ASSET_SOURCE_DIRECTORIES[group];
	for (const directory of directories) {
		const resolved = path.join(root, directory);
		const names = fs.readdirSync(resolved).filter((name) => {
			return fs.statSync(path.join(resolved, name)).isFile();
		});

		for (const name of names) {
			digests.set(name, digest(fs.readFileSync(path.join(resolved, name))));
		}
	}

	return digests;
}

function digestBundledAssets(group: HtmlAssetGroup): Map<string, string> {
	return new Map(
		istanbulHtmlAssets[group].map((asset) => {
			const content =
				"text" in asset
					? Buffer.from(asset.text, "utf-8")
					: Buffer.from(asset.base64, "base64");
			return [asset.name, digest(content)];
		}),
	);
}

describe("bundled istanbul html assets", () => {
	it.for<HtmlAssetGroup>(["html", "html-spa"])(
		"should carry the %s assets byte-identical to istanbul's own",
		(group) => {
			expect.assertions(1);

			// Names as well as bytes: an istanbul upgrade that adds an asset
			// has to reach the bundle, and nothing else here would notice.
			expect(digestBundledAssets(group)).toStrictEqual(digestSourceAssets(group));
		},
	);
});
