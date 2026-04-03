<h1 align="center">jest-roblox-cli</h1>

<p align="center">
  <a href="https://www.npmx.dev/package/@isentinel/jest-roblox"><img src="https://img.shields.io/npm/v/@isentinel/jest-roblox" alt="npm version"></a>
  <a href="https://github.com/christopher-buss/jest-roblox-cli/actions/workflows/ci.yaml"><img src="https://github.com/christopher-buss/jest-roblox-cli/actions/workflows/ci.yaml/badge.svg" alt="CI"></a>
  <a href="https://github.com/christopher-buss/jest-roblox-cli/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
</p>


Run your roblox-ts and Luau tests inside Roblox, get results in your terminal.

<p align="center">
  <img src="assets/cli-example.png" alt="jest-roblox-cli output" width="700">
</p>

- roblox-ts and pure Luau
- Source-mapped errors (Luau line numbers back to `.ts` files)
- Code coverage (via [Lute](https://github.com/luau-lang/lute) instrumentation)
- Two backends: Open Cloud (remote) and Studio (local)
- Multiple output formatters (human, agent, JSON, GitHub Actions)

> [!NOTE]
> roblox-ts projects currently require
> [@isentinel/roblox-ts](https://npmx.dev/package/@isentinel/roblox-ts) for
> source maps and coverage support.

## Install

```bash
npm install @isentinel/jest-roblox
```

### Standalone binary (no Node.js required)

Pre-built binaries are attached to each
[GitHub release](https://github.com/christopher-buss/jest-roblox-cli/releases).
Install with your preferred tool manager:

```bash
mise use github:christopher-buss/jest-roblox-cli
rokit add christopher-buss/jest-roblox-cli

```

Limitations vs the npm package:

- `--typecheck` and `--typecheckOnly` are not available
- `.ts` config files are not supported (use `.json`, `.js`, or `.mjs`)
- External tools (rojo, lute for coverage) must still be on your `PATH`

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
jest-roblox --testPathPattern="modifiers|define\\.spec|triggers"

# Use a specific backend
jest-roblox --backend studio
jest-roblox --backend open-cloud

# Collect coverage
jest-roblox --coverage

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
> Coverage requires [Lute](https://github.com/luau-lang/lute) to be installed and
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
				displayName: { name: "client", color: "magenta" },
				include: ["**/*.spec.ts"],
				mockDataModel: true,
				outDir: "out/src/client",
			}),
		},
		{
			test: defineProject({
				displayName: { name: "server", color: "white" },
				include: ["**/*.spec.ts"],
				outDir: "out/src/server",
			}),
		},
	],
});
```

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
step), but Studio must be open with the plugin running. Studio doesn't expose which place is open, so
multiple concurrent projects aren't supported yet.

Install the plugin with [Drillbit](https://github.com/jacktabscode/drillbit):

#### Configuration file

Create a file named drillbit.toml in your project's directory.

```toml
[plugins.jest_roblox]
github = "https://github.com/christopher-buss/jest-roblox-cli/releases/download/v0.2.1/JestRobloxRunner.rbxm"
```

Then run `drillbit` and it will download the plugin and install it in Studio for you.

Or download `JestRobloxRunner.rbxm` from the
[latest release](https://github.com/christopher-buss/jest-roblox-cli/releases)
and drop it into your Studio plugins folder.

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

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
