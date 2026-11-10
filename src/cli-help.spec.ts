import { describe, expect, it } from "vitest";

import { renderHelp } from "./cli-help.ts";
import type { OptionRow } from "./config/option-row.ts";
import { OPTION_ROWS } from "./config/options.ts";

function spellings({ cli }: OptionRow): Array<string> {
	if (cli === undefined) {
		return [];
	}

	return cli.negation === undefined ? [cli.name] : [cli.name, cli.negation.name];
}

function isListed(help: string, name: string): boolean {
	const entry = new RegExp(String.raw`^ {2}(?:-\w, )?--${name}(?![\w-])`, "m");
	return entry.test(help);
}

describe(renderHelp, () => {
	it("should list every flag the parser accepts", () => {
		expect.assertions(1);

		const help = renderHelp();
		const missing = OPTION_ROWS.flatMap(spellings).filter((name) => !isListed(help, name));

		expect(missing).toStrictEqual([]);
	});

	it("should frame the flag sections with the usage header and the footer", () => {
		expect.assertions(3);

		const help = renderHelp();

		expect(help).toStartWith(
			"\n\nUsage: jest-roblox [options] [files...]\n       jest-roblox setup\n\nCommands:\n",
		);
		expect(help).toContain(
			"\n\n  --apiKey is visible in process listings; prefer env vars in CI.\n\nExamples:\n",
		);
		expect(help).toEndWith("Skip coverage instrumentation for this run\n\n");
	});

	it("should list the sections in order", () => {
		expect.assertions(1);

		const headings = renderHelp()
			.split("\n")
			.filter((line) => /^[A-Z][\w ]*:$/.test(line));

		expect(headings).toStrictEqual([
			"Commands:",
			"Backend:",
			"Config:",
			"Filtering:",
			"Output:",
			"Coverage:",
			"Type tests:",
			"Workspace:",
			"Open Cloud:",
			"General:",
			"Examples:",
		]);
	});

	it("should render short flags, values, negations and repeatable flags", () => {
		expect.assertions(3);

		const help = renderHelp();

		expect(help).toContain(
			"\n  -t, --testNamePattern <regex>     Filter tests by name pattern\n",
		);
		expect(help).toContain(
			"\n  --color                           Force colored output\n  --no-color                        Disable colored output\n",
		);
		expect(help).toContain(
			"\n  --project <name>                  Filter which named projects to run\n                                    (repeatable)\n",
		);
	});

	it("should fill each line up to the column limit before wrapping", () => {
		expect.assertions(1);

		expect(renderHelp()).toContain(
			"\n  --hiddenDesktop                   Run the studio-cli Studio hidden (default on\n                                    Windows and macOS)\n",
		);
	});

	it("should keep every line within 80 columns", () => {
		expect.assertions(1);

		const long = renderHelp()
			.split("\n")
			.filter((line) => line.length > 80);

		expect(long).toStrictEqual([]);
	});

	it("should hold only flag rows and their wrapped lines under each section", () => {
		expect.assertions(1);

		const sections = renderHelp()
			.split("\n\nOpen Cloud credentials", 1)[0]!
			.split("\n\nBackend:\n", 2)[1]!;
		const sectionLine = /^(?:|[A-Z][\w ]*:| {2}-.*| {36}\S.*)$/;
		const strays = sections.split("\n").filter((line) => !sectionLine.test(line));

		expect(strays).toStrictEqual([]);
	});
});
