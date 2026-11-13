import { keys, sortBy } from "remeda";

import type { AnyCliFlag, HelpSection } from "./config/option-row.ts";
import { OPTION_ROWS } from "./config/options.ts";

const SECTION_RANK = {
	"Backend": 0,
	"Config": 1,
	"Coverage": 4,
	"Filtering": 2,
	"General": 8,
	"Open Cloud": 7,
	"Output": 3,
	"Type tests": 5,
	"Workspace": 6,
} satisfies Record<HelpSection, number>;

const SECTION_ORDER = sortBy(keys(SECTION_RANK), (section) => SECTION_RANK[section]);

const LABEL_COLUMN = 36;

const WIDTH = 80;

const HEADER = `Usage: jest-roblox [options] [files...]
       jest-roblox setup

Commands:
  setup                             Install the Luau Config type and add the
                                    "jest-roblox" alias to .config.luau or
                                    .luaurc. Write a test filter named setup
                                    as ./setup`;

const FOOTER = `Open Cloud credentials (open-cloud backend only):
  Sources, in precedence order:
    1. CLI flags (--apiKey, --universeId, --placeId)
    2. JEST_ROBLOX_* env vars (JEST_ROBLOX_OPEN_CLOUD_API_KEY,
       JEST_ROBLOX_UNIVERSE_ID, JEST_ROBLOX_PLACE_ID)
    3. ROBLOX_* env vars (ROBLOX_OPEN_CLOUD_API_KEY, ROBLOX_UNIVERSE_ID,
       ROBLOX_PLACE_ID)
    4. jest.config.ts (universeId, placeId; apiKey is CLI/env only)

  --apiKey is visible in process listings; prefer env vars in CI.

Examples:
  jest-roblox                         Run all tests (auto backend)
  jest-roblox --backend studio        Run tests via Studio plugin
  jest-roblox src/player.spec.ts      Run specific test file (also narrows
                                      a --workspace run to its package)
  jest-roblox -t "should spawn"       Run tests matching pattern
  jest-roblox --formatters json       Print results as JSON
  jest-roblox --coverage              Run tests with coverage instrumentation
  jest-roblox --no-coverage           Skip coverage instrumentation for this run`;

/**
 * The `--help` page, one line group per flag in the option registry.
 *
 * @returns The help text.
 */
export function renderHelp(): string {
	const sections = SECTION_ORDER.map((section) => {
		const lines = OPTION_ROWS.flatMap(({ cli }) => {
			return cli?.section === section ? flagLines(cli) : [];
		});
		return [`${section}:`, ...lines].join("\n");
	});

	return ["", HEADER, ...sections, FOOTER, ""].join("\n\n");
}

function wrap(text: string, width: number): Array<string> {
	const lines: Array<string> = [];
	let current = "";
	for (const word of text.split(" ")) {
		if (current.length + 1 + word.length > width) {
			lines.push(current);
			current = word;
		} else {
			current = current === "" ? word : `${current} ${word}`;
		}
	}

	lines.push(current);
	return lines;
}

function row(label: string, text: string): Array<string> {
	const indent = " ".repeat(LABEL_COLUMN);
	const labelCell = `  ${label}`.padEnd(LABEL_COLUMN - 1);
	return wrap(text, WIDTH - LABEL_COLUMN).map((line, index) => {
		return index === 0 ? `${labelCell} ${line}` : `${indent}${line}`;
	});
}

function flagLines(cli: AnyCliFlag): Array<string> {
	const names = cli.short === undefined ? `--${cli.name}` : `-${cli.short}, --${cli.name}`;
	const label = cli.value === undefined ? names : `${names} ${cli.value}`;
	const help = cli.multiple === true ? `${cli.help} (repeatable)` : cli.help;
	const negation =
		cli.negation === undefined ? [] : row(`--${cli.negation.name}`, cli.negation.help);
	return [...row(label, help), ...negation];
}
