/**
 * `istanbul-reports` ships no declarations for its reporter modules — its own
 * types describe the `create(name)` factory instead, which is exactly what
 * cannot be used here (see `reporter-registry.ts`). Every module under `lib/`
 * default-exports one reporter class taking that reporter's options object.
 */
declare module "istanbul-reports/lib/*" {
	import type { ReportBase } from "istanbul-lib-report";

	const Report: new (options?: object) => ReportBase;
	export default Report;
}

/**
 * The html reporter, declared past the wildcard because two of its members are
 * reached by name: `onStart`, whose asset copy is replaced, and the writer that
 * says which directory the replacement writes into.
 */
declare module "istanbul-reports/lib/html/index.js" {
	import type { Context, FileWriter, Node, ReportBase } from "istanbul-lib-report";

	interface HtmlReport extends ReportBase {
		getWriter(context: Context): FileWriter;
		onStart(root: Node, context: Context): void;
	}

	const HtmlReport: new (options?: object) => HtmlReport;
	export default HtmlReport;
}

/** As `html`, plus the html report this one delegates to. */
declare module "istanbul-reports/lib/html-spa/index.js" {
	import type { Context, FileWriter, Node, ReportBase } from "istanbul-lib-report";
	import type HtmlReport from "istanbul-reports/lib/html/index.js";

	interface HtmlSpaReport extends ReportBase {
		getWriter(context: Context): FileWriter;
		htmlReport: HtmlReport;
		onStart(root: Node, context: Context): void;
	}

	const HtmlSpaReport: new (options?: object) => HtmlSpaReport;
	export default HtmlSpaReport;
}

/**
 * `lcov` is an lcov file and an html report, and the html half needs assets.
 */
declare module "istanbul-reports/lib/lcov/index.js" {
	import type { ReportBase } from "istanbul-lib-report";
	import type HtmlReport from "istanbul-reports/lib/html/index.js";

	interface LcovReport extends ReportBase {
		html: HtmlReport;
	}

	const LcovReport: new (options?: object) => LcovReport;
	export default LcovReport;
}

/**
 * The html reporters' own asset files, read out of the installed
 * `istanbul-reports` by whichever loader builds this module — see
 * `loaders/istanbul-html-assets.mjs` for what it holds and why.
 */
declare module "virtual:istanbul-html-assets" {
	/** One asset file: text carries a header when copied, bytes do not. */
	type IstanbulHtmlAsset = { base64: string; name: string } | { name: string; text: string };

	const istanbulHtmlAssets: {
		"html": Array<IstanbulHtmlAsset>;
		"html-spa": Array<IstanbulHtmlAsset>;
	};
	export default istanbulHtmlAssets;
}
