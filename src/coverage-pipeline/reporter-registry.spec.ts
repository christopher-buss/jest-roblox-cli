import istanbulCoverage from "istanbul-lib-coverage";
import istanbulReport from "istanbul-lib-report";
import { Buffer } from "node:buffer";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";

import type { CoverageReporter } from "../config/schema.ts";
import { isCoverageReporter, VALID_COVERAGE_REPORTERS } from "../config/schema.ts";
import type { HtmlAssetGroup } from "./html-assets.ts";
import { writeIstanbulHtmlAssets } from "./html-assets.ts";
import { createReporter } from "./reporter-registry.ts";

/** Where istanbul keeps the assets the bundled copies are built from. */
const ASSET_SOURCE_DIRECTORIES: Record<HtmlAssetGroup, Array<string>> = {
	"html": ["lib/html/assets", "lib/html/assets/vendor"],
	"html-spa": ["lib/html-spa/assets"],
};

/** What istanbul's html reporter prepends to a `.js` asset as it copies it. */
const JS_ASSET_HEADER = Buffer.from("/* eslint-disable */\n", "utf-8");

const ALL_REPORTERS: Array<CoverageReporter> = [...VALID_COVERAGE_REPORTERS].filter((name) => {
	return isCoverageReporter(name);
});

function istanbulReportsRoot(): string {
	const require = createRequire(import.meta.url);
	return path.dirname(require.resolve("istanbul-reports/package.json"));
}

/**
 * Every asset istanbul would have copied, in the form it would have left it.
 */
function readSourceAssets(group: HtmlAssetGroup): Map<string, Buffer> {
	const root = istanbulReportsRoot();
	const assets = new Map<string, Buffer>();

	const directories = ASSET_SOURCE_DIRECTORIES[group];
	for (const directory of directories) {
		const resolved = path.join(root, directory);
		const names = fs.readdirSync(resolved).filter((name) => {
			return fs.statSync(path.join(resolved, name)).isFile();
		});

		for (const name of names) {
			const content = fs.readFileSync(path.join(resolved, name));
			assets.set(
				name,
				name.endsWith(".js") ? Buffer.concat([JS_ASSET_HEADER, content]) : content,
			);
		}
	}

	return assets;
}

function readWrittenAssets(directory: string): Map<string, Buffer> {
	const names = fs.readdirSync(directory);
	return new Map(names.map((name) => [name, fs.readFileSync(path.join(directory, name))]));
}

/**
 * A real istanbul file writer rooted at `directory`. Reached through
 * `createContext` because that is how a reporter gets one, and the write it
 * performs — bytes through a file descriptor typed for strings — is the half of
 * this that has to hold.
 */
function createContext(directory: string): istanbulReport.Context {
	return istanbulReport.createContext({
		coverageMap: istanbulCoverage.createCoverageMap({}),
		dir: directory,
	});
}

function createWriter(directory: string): istanbulReport.Context["writer"] {
	return istanbulReport.createContext({
		coverageMap: istanbulCoverage.createCoverageMap({}),
		dir: directory,
	}).writer;
}

function createTemporaryDirectory(): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jest-roblox-assets-"));
	onTestFinished(() => {
		fs.rmSync(directory, { force: true, recursive: true });
	});
	return directory;
}

describe(createReporter, () => {
	it("should cover every reporter a config may name", () => {
		expect.assertions(1);

		expect(ALL_REPORTERS).toHaveLength(VALID_COVERAGE_REPORTERS.size);
	});

	// Construction is where the bundled build used to fail, and it fails per
	// reporter, so every name a config may carry is built here rather than only
	// the two the defaults reach.
	it.for(ALL_REPORTERS)("should construct the %s reporter", (name) => {
		expect.assertions(1);

		expect(createReporter(name, {})).toBeDefined();
	});
});

// Copying istanbul's own asset bundle and reading every byte back is real disk
// work — past the mutation run's 100ms default, and slowest for `html-spa`,
// whose prebuilt bundle dwarfs the other group.
describe(writeIstanbulHtmlAssets, { timeout: 2000 }, () => {
	it.for<HtmlAssetGroup>(["html", "html-spa"])(
		"should write the %s assets byte-identical to istanbul's own",
		(group) => {
			expect.assertions(1);

			const directory = createTemporaryDirectory();

			writeIstanbulHtmlAssets(createWriter(directory), group);

			// Names as well as bytes: an istanbul upgrade that adds an asset
			// has to reach the bundle, and nothing else here would notice.
			expect(readWrittenAssets(directory)).toStrictEqual(readSourceAssets(group));
		},
	);
});

// Each html-writing reporter reaches its assets through a hook of its own, and
// a report run is what calls those hooks. "lcov" roots its html in a
// subdirectory; the other two write at the top.
describe("report execution", () => {
	it.for<[CoverageReporter, string]>([
		["html", "."],
		["html-spa", "."],
		["lcov", "lcov-report"],
	])("should write the %s report with its assets", ([name, subdirectory]) => {
		expect.assertions(1);

		const directory = createTemporaryDirectory();

		createReporter(name, {}).execute(createContext(directory));

		expect(fs.existsSync(path.join(directory, subdirectory, "base.css"))).toBeTrue();
	});
});
