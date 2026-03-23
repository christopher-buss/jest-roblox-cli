# jest-roblox-cli

[![npm version](https://img.shields.io/npm/v/@isentinel/jest-roblox)](https://www.npmx.dev/package/@isentinel/jest-roblox)
[![CI](https://github.com/christopher-buss/jest-roblox-cli/actions/workflows/ci.yaml/badge.svg)](https://github.com/christopher-buss/jest-roblox-cli/actions/workflows/ci.yaml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/christopher-buss/jest-roblox-cli/blob/main/LICENSE)


Run your TypeScript and Luau tests inside Roblox, then see the results in your
terminal.

jest-roblox-cli builds a Roblox place from your test files, runs it in Roblox,
and reports results in your terminal. It works with roblox-ts and pure Luau
projects. For TypeScript, it maps Luau errors back to your `.ts` source.

## Why?

Roblox code can only run inside the Roblox engine. Standard test runners
can't access the Roblox API. This tool bridges that gap by running tests in a
real Roblox session and piping results back to your terminal.

- roblox-ts and pure Luau
- Source-mapped errors (Luau line numbers back to `.ts` files)
- Code coverage
- Two backends: Open Cloud (remote) and Studio (local)

## Install

```bash
npm install @isentinel/jest-roblox
```

## Quick start

Add a `jest.config.ts` (or `.js`, `.json`, `.yaml`, `.toml`) to your project
root:

```typescript
import { defineConfig } from "@isentinel/jest-roblox";

export default defineConfig({
	placeFile: "./game.rbxl",
	projects: ["ReplicatedStorage/shared"],
});
```

Then run:

```bash
jest-roblox
```

## Usage

```bash
# Run all tests
jest-roblox

# Run one file (TypeScript or Luau)
jest-roblox src/player.spec.ts
jest-roblox src/player.spec.luau

# Filter by test name
jest-roblox -t "should spawn"

# Filter by file path
jest-roblox --testPathPattern player

# Use a specific backend
jest-roblox --backend studio
jest-roblox --backend open-cloud

# Collect coverage
jest-roblox --coverage

# Output JSON results
jest-roblox --formatters json --outputFile results.json

# Short output for AI tools
jest-roblox --formatters agent

# Save game output (print/warn/error) to file
jest-roblox --gameOutput game-logs.txt

# Run only specific named projects
jest-roblox --project client
```

## Configuration

Config files are loaded by [c12](https://github.com/unjs/c12), which
auto-discovers `jest.config.*` in any format it supports (`.ts`, `.js`, `.mjs`,
`.cjs`, `.json`, `.yaml`, `.toml`).

Configs can extend a shared base with `extends`:

```typescript
export default defineConfig({
	extends: "../../jest.shared.ts",
	projects: ["ReplicatedStorage/shared"],
});
```

Precedence: CLI flags > config file > extended config > defaults.

### Config fields

| Field | What it does | Default |
|---|---|---|
| `projects` | Where to look for tests in the DataModel | **required** |
| `backend` | `"open-cloud"` or `"studio"` | — |
| `placeFile` | Path to your `.rbxl` file | `"./game.rbxl"` |
| `timeout` | Max time for tests to run (ms) | `300000` (5 min) |
| `sourceMap` | Map Luau errors back to TypeScript (roblox-ts only) | `true` |
| `port` | WebSocket port for Studio backend | `3001` |
| `testMatch` | Glob patterns that find test files | `**/*.spec.ts`, `**/*.test.ts`, etc. |
| `testPathIgnorePatterns` | Patterns to skip | `/node_modules/`, `/dist/`, `/out/` |
| `rojoProject` | Path to your Rojo project file | auto |
| `jestPath` | Where Jest lives in the DataModel | auto |
| `setupFiles` | Scripts to run before the test environment loads | — |
| `setupFilesAfterEnv` | Scripts to run after the test environment loads | — |
| `formatters` | Output formatters (`"default"`, `"agent"`, `"json"`, `"github-actions"`) | `["default"]` |
| `gameOutput` | Path to write game print/warn/error output | — |
| `showLuau` | Show Luau code snippets in failure output | `true` |
| `cache` | Cache place file uploads by content hash | `true` |
| `pollInterval` | How often to poll for results in ms (Open Cloud) | `500` |

### Coverage fields

> [!IMPORTANT]
> Coverage requires [Lute](https://github.com/4lve/lute) to be installed and
> on your `PATH`. Lute parses Luau ASTs so the CLI can insert coverage probes.

| Field | What it does | Default |
|---|---|---|
| `collectCoverage` | Turn on coverage | `false` |
| `coverageDirectory` | Where to write coverage reports | `"coverage"` |
| `coverageReporters` | Which report formats to use | `["text", "lcov"]` |
| `coverageThreshold` | Minimum coverage to pass | — |
| `coveragePathIgnorePatterns` | Files to leave out of coverage | test files, `node_modules`, `rbxts_include` |
| `collectCoverageFrom` | Globs for files to include in coverage | — |
| `luauRoots` | Where Luau files live (auto from tsconfig `outDir` for roblox-ts, or set by hand for pure Luau) | auto |

### Project-level config

`projects` can be strings (DataModel paths) or objects with per-project
overrides:

```typescript
import { defineConfig, defineProject } from "@isentinel/jest-roblox";

export default defineConfig({
	placeFile: "./game.rbxl",
	projects: [
		{
			test: defineProject({
				displayName: { name: "core", color: "magenta" },
				include: ["src/**/*.spec.ts"],
				mockDataModel: true,
				outDir: "out-test/src",
			}),
		},
		{
			test: defineProject({
				displayName: { name: "core:integration", color: "white" },
				include: ["test/**/*.spec.ts"],
				mockDataModel: true,
				outDir: "out-test/test",
			}),
		},
	],
});
```

Available per-project fields: `displayName`, `include`, `exclude`, `testMatch`,
`testRegex`, `testPathIgnorePatterns`, `setupFiles`, `setupFilesAfterEnv`,
`testTimeout`, `slowTestThreshold`, `testEnvironment`, `snapshotFormat`,
`outDir`, `root`, and the Jest mock flags (`clearMocks`, `resetMocks`, etc.).

### Full example

```typescript
import { defineConfig } from "@isentinel/jest-roblox";

export default defineConfig({
	backend: "open-cloud",
	collectCoverage: true,
	coverageThreshold: {
		branches: 70,
		functions: 80,
		statements: 80,
	},
	jestPath: "ReplicatedStorage/Packages/Jest",
	placeFile: "./game.rbxl",
	projects: ["ReplicatedStorage/client", "ServerScriptService/server"],
	timeout: 60000,
});
```

## Backends

Two ways to run tests:

### Open Cloud (remote)

Uploads your place file to Roblox and polls for results.

You need these environment variables:

| Variable | What it is |
|---|---|
| `ROBLOX_OPEN_CLOUD_API_KEY` | Your Open Cloud API key |
| `ROBLOX_UNIVERSE_ID` | The universe to run tests in |
| `ROBLOX_PLACE_ID` | The place to run tests in |

### Studio (local)

Connects to Roblox Studio over WebSocket. Faster than Open Cloud (no upload
step), but Studio must be open with the plugin running.

## CLI flags

| Flag | What it does |
|---|---|
| `--backend <type>` | Choose `open-cloud` or `studio` |
| `--port <n>` | WebSocket port for Studio |
| `--config <path>` | Path to config file |
| `--testPathPattern <regex>` | Filter test files by path |
| `-t, --testNamePattern <regex>` | Filter tests by name |
| `--formatters <name...>` | Output formatters (`default`, `agent`, `json`, `github-actions`) |
| `--outputFile <path>` | Write results to a file |
| `--gameOutput <path>` | Write game print/warn/error to a file |
| `--coverage` | Collect coverage |
| `--coverageDirectory <path>` | Where to put coverage reports |
| `--coverageReporters <r...>` | Which report formats to use |
| `--luauRoots <path...>` | Where compiled Luau files live |
| `--no-show-luau` | Hide Luau code in failure output |
| `-u, --updateSnapshot` | Update snapshot files |
| `--sourceMap` | Map Luau errors to TypeScript (roblox-ts only) |
| `--rojoProject <path>` | Path to Rojo project file |
| `--verbose` | Show each test result |
| `--silent` | Hide all output |
| `--no-color` | Turn off colors |
| `--no-cache` | Force a fresh place file upload |
| `--pollInterval <ms>` | How often to check for results (Open Cloud) |
| `--project <name...>` | Filter which named projects to run |
| `--projects <path...>` | DataModel paths that hold tests |
| `--setupFiles <path...>` | Scripts to run before env |
| `--setupFilesAfterEnv <path...>` | Scripts to run after env |
| `--typecheck` | Run type tests too |
| `--typecheckOnly` | Run only type tests |
| `--typecheckTsconfig <path>` | tsconfig for type tests |

## How it works

1. Finds files matching `testMatch` patterns
2. Builds a `.rbxl` via Rojo
3. Sends the place to Roblox (Open Cloud upload or Studio WebSocket)
4. Parses Jest JSON output from the session
5. Maps Luau line numbers to TypeScript via source maps (roblox-ts only)
6. Prints results

> [!NOTE]
> Coverage adds extra steps: copy Luau files, insert tracking probes, build a
> separate place file, then map hit counts back to source. For roblox-ts, this
> goes through source maps to report TypeScript lines.

## Test file patterns

Default `testMatch` patterns (configurable):

- TypeScript: `*.spec.ts`, `*.test.ts`, `*.spec.tsx`, `*.test.tsx`
- Luau: `*.spec.lua`, `*.test.lua`, `*.spec.luau`, `*.test.luau`
- Type tests: `*.spec-d.ts`, `*.test-d.ts`

## Project structure

```text
jest-roblox-cli/
├── bin/              CLI entry point
├── src/
│   ├── backends/     Open Cloud and Studio backends
│   ├── config/       Config loading and validation
│   ├── coverage/     Coverage instrumentation pipeline
│   ├── formatters/   Output formatters (default, agent, JSON, GitHub Actions)
│   ├── highlighter/  Luau syntax highlighting
│   ├── reporter/     Result parsing and validation
│   ├── source-mapper/ Luau-to-TypeScript error mapping
│   ├── snapshot/     Snapshot file handling
│   ├── typecheck/    Type test runner
│   ├── types/        Shared type definitions
│   └── utils/        Helpers (glob, hash, cache, paths)
├── luau/             Luau code that runs inside Roblox
├── plugin/           Roblox Studio WebSocket plugin
└── test/             Test fixtures and mocks
```

## Contributing

### Build

```bash
pnpm build         # Full build
pnpm watch         # Watch mode
pnpm typecheck     # Check types
```

### Test

```bash
vitest run                    # All tests
vitest run src/formatters     # One folder
vitest run src/cli.spec.ts    # One file
```

### Lint

```bash
eslint .
```

> [!IMPORTANT]
> 100% test coverage is enforced. Write tests first. Every PR must maintain full coverage.

## License

MIT
