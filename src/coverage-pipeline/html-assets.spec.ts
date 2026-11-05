import istanbulCoverage from "istanbul-lib-coverage";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import * as path from "node:path";
import istanbulHtmlAssets from "virtual:istanbul-html-assets";
import { assert, describe, expect, it, vi } from "vitest";

import { createMemoryReportEnvironment } from "#test/mocks/memory-report-context.ts";
import type { FileSystem } from "../utils/file-system.ts";
import type { HtmlAssetGroup } from "./html-assets.ts";
import { writeIstanbulHtmlAssets } from "./html-assets.ts";

/** What istanbul's html reporter prepends to a `.js` asset as it copies it. */
const JS_ASSET_HEADER = Buffer.from("/* eslint-disable */\n", "utf-8");

/**
 * Every bundled asset, in the form istanbul's own copy would have left it.
 * @param group - Asset group to read.
 * @returns Asset bytes by file name.
 */
function readBundledAssets(group: HtmlAssetGroup): Map<string, Buffer> {
	return new Map(
		istanbulHtmlAssets[group].map((asset) => {
			if ("text" in asset) {
				const text = Buffer.from(asset.text, "utf-8");
				return [
					asset.name,
					asset.name.endsWith(".js") ? Buffer.concat([JS_ASSET_HEADER, text]) : text,
				];
			}

			return [asset.name, Buffer.from(asset.base64, "base64")];
		}),
	);
}

function readWrittenAssets(directory: string, fileSystem: FileSystem): Map<string, Buffer> {
	const names = fileSystem.readdirSync(directory);
	return new Map(
		names.map((name) => [name, fileSystem.readFileSync(path.join(directory, name))]),
	);
}

function digestAssets(assets: Map<string, Buffer>): Map<string, string> {
	return new Map(
		Array.from(assets, ([name, content]) => {
			return [name, createHash("sha256").update(content).digest("hex")];
		}),
	);
}

describe(writeIstanbulHtmlAssets, () => {
	it.for<HtmlAssetGroup>(["html", "html-spa"])(
		"should write every bundled %s asset with istanbul's js header",
		(group) => {
			expect.assertions(1);

			const { createContext, directory, fileSystem } = createMemoryReportEnvironment();

			writeIstanbulHtmlAssets(
				createContext({
					coverageMap: istanbulCoverage.createCoverageMap({}),
					dir: directory,
				}).writer,
				group,
			);

			expect(digestAssets(readWrittenAssets(directory, fileSystem))).toStrictEqual(
				digestAssets(readBundledAssets(group)),
			);
		},
	);

	it("should close every asset writer after publishing", () => {
		expect.assertions(1);

		const { createContext, directory } = createMemoryReportEnvironment();
		const { writer } = createContext({
			coverageMap: istanbulCoverage.createCoverageMap({}),
			dir: directory,
		});
		const writeFile = writer.writeFile.bind(writer);
		const closed: Array<string> = [];
		vi.spyOn(writer, "writeFile").mockImplementation((name) => {
			assert(name !== null);
			const contentWriter = writeFile(name);
			const close = contentWriter.close.bind(contentWriter);
			vi.spyOn(contentWriter, "close").mockImplementation(() => {
				closed.push(name);
				close();
			});
			return contentWriter;
		});

		writeIstanbulHtmlAssets(writer, "html");

		expect(closed.sort()).toStrictEqual([...readBundledAssets("html").keys()].sort());
	});
});
