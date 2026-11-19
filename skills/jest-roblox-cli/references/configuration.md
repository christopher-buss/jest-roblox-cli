# Configuration

Config file: `jest.config.*`, in any format c12 loads (`.ts`, `.js`, `.mjs`,
`.cjs`, `.json`, `.yaml`, `.toml`). A config can inherit a shared base with
`extends: "../jest.shared.ts"`.

## Root Fields

Root fields control the CLI and the runner. Jest fields go under `test:`.

| Field                  | Purpose                                                                                                     | Default                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `backend`              | `"auto"`, `"studio-cli"`, `"open-cloud"`, or `"studio"`                                                     | `"auto"`                                 |
| `bootProbeTimeout`     | How long the Open Cloud boot probe may take to prove a place version starts (ms). `0` skips the probe       | `90000`                                  |
| `color`                | Force colored output                                                                                        | `true`                                   |
| `coverageCache`        | Reuse the instrumented coverage files between runs                                                          | `true`                                   |
| `extends`              | Config files to inherit from, relative to this file                                                         | -                                        |
| `forceRerunTriggers`   | Globs, relative to the workspace root, that make `related` or `--changed` run every test                    | the lockfiles                            |
| `formatters`           | Output formatters (`"default"`, `"agent"`, `"json"`, `"github-actions"`)                                    | `["default"]`                            |
| `gameOutput`           | Write game print/warn/error to a file: a path, or `true` for `game-output.log`                              | -                                        |
| `hiddenDesktop`        | Run the `studio-cli` Studio hidden                                                                          | `true` on Windows and macOS              |
| `jestPath`             | DataModel path to the Jest module (e.g. `"ReplicatedStorage/Packages/Jest"`)                                | found in ReplicatedStorage               |
| `luauRoots`            | Compiled Luau folders to instrument for coverage                                                            | from Rojo mounts, then tsconfig `outDir` |
| `outputFile`           | Write the Jest result JSON: a path, or `true` for `jest-output.log`                                         | -                                        |
| `parallel`             | Concurrent Open Cloud sessions, or `"auto"` (= `min(jobs, 3)`)                                              | one session                              |
| `placeFile`            | Path to the `.rbxl` file                                                                                    | `"./game.rbxl"`                          |
| `placeId`              | Open Cloud place to run tests in (also `ROBLOX_PLACE_ID`)                                                   | -                                        |
| `pluginsDirectory`     | Absolute path of the Studio plugins folder that `studio-cli` installs into (also `JEST_ROBLOX_PLUGINS_DIR`) | the Studio plugins folder of your OS     |
| `port`                 | WebSocket port for the `studio` backend                                                                     | `3001`                                   |
| `rojoProject`          | Path to the Rojo project file                                                                               | found in the root folder                 |
| `rootDir`              | Base folder for relative paths, relative to the config file                                                 | the current folder                       |
| `showLuau`             | Show the Luau line in error output                                                                          | `true`                                   |
| `sourceMap`            | Map Luau stack traces to your source                                                                        | `true`                                   |
| `studioPath`           | Roblox Studio executable for `studio-cli` (also `JEST_ROBLOX_STUDIO_PATH`)                                  | found on your machine                    |
| `timeout`              | Max run time in Roblox (ms)                                                                                 | `300000`                                 |
| `universeId`           | Open Cloud universe that owns the place (also `ROBLOX_UNIVERSE_ID`)                                         | -                                        |
| `uploadCache`          | Skip the place upload when the place file did not change                                                    | `true`                                   |
| `workspace.exclude`    | Globs of package folders that a `--workspace` run skips                                                     | -                                        |
| `workspace.gameOutput` | `true` to write game output for each package under `.jest-roblox/output/`                                   | -                                        |
| `workspace.outputFile` | `true` to write a result file for each package under `.jest-roblox/output/`                                 | -                                        |
| `workspace.packages`   | Globs of package folders. Needs `workspace.root`                                                            | -                                        |
| `workspace.root`       | Workspace root, relative to this file. Needs `workspace.packages`                                           | -                                        |

## Test Fields

Put these under `test: { ... }`. A field marked "root only" is not valid inside
a project. A field marked "project only" is valid only inside a project.

| Field                    | Purpose                                                                        | Default                              |
| ------------------------ | ------------------------------------------------------------------------------ | ------------------------------------ |
| `all`                    | Report coverage for files with no test too (root only)                         | `false`                              |
| `automock`               | Mock every required module                                                     | `false`                              |
| `bail`                   | Stop after `n` failed test files (root only)                                   | `0`                                  |
| `changedSince`           | Run only the tests that files changed since this git ref affect (root only)    | -                                    |
| `ci`                     | Act as CI, so new snapshots are not written (root only)                        | -                                    |
| `clearCache`             | Clear the Jest cache, then exit (root only)                                    | -                                    |
| `clearMocks`             | Clear every mock before each test                                              | `false`                              |
| `debug`                  | Print the Jest config and debug data (root only)                               | -                                    |
| `displayName`            | Label for the project in output: a string or `{ name, color }`                 | -                                    |
| `env`                    | Test environment to use (root only)                                            | -                                    |
| `exclude`                | Globs removed from test discovery                                              | -                                    |
| `expand`                 | Show full diffs and errors (root only)                                         | -                                    |
| `globals`                | JSON string of globals for every test environment (root only)                  | -                                    |
| `include`                | Globs of the test files of a project                                           | -                                    |
| `injectGlobals`          | Put the Jest globals in the test environment                                   | `true`                               |
| `maxWorkers`             | Max worker count, or a percentage such as `"50%"` (root only)                  | -                                    |
| `mockDataModel`          | Give each test file a new mock DataModel                                       | `false`                              |
| `noStackTrace`           | Do not show stack traces in failures (root only)                               | -                                    |
| `outDir`                 | Compiled output folder of the `.luau` files                                    | -                                    |
| `passWithNoTests`        | Exit `0` when no tests are found (root only)                                   | `false`                              |
| `preset`                 | Name of a preset that gives base Jest config (root only)                       | -                                    |
| `projectTimeout`         | Max time for one project in Roblox (ms). `0` turns it off                      | `60000`                              |
| `projects`               | DataModel paths or `defineProject` entries to search for tests (root only)     | one project per `luauRoots` folder   |
| `reporters`              | Reporter modules (DataModel paths) (root only)                                 | -                                    |
| `resetMocks`             | Reset every mock before each test                                              | `false`                              |
| `resetModules`           | Reset the module registry before each test                                     | `false`                              |
| `restoreMocks`           | Restore `spyOn` mocks before each test                                         | `false`                              |
| `root`                   | Base folder for the project's `include`, `exclude` and `outDir` (project only) | -                                    |
| `roots`                  | Folders Jest scans for tests and modules (root only)                           | -                                    |
| `runInBand`              | Run all tests one after another in one process (root only)                     | -                                    |
| `selectProjects`         | Run only the projects with these `displayName`s (root only)                    | -                                    |
| `setupFiles`             | DataModel paths to scripts that run before the test framework                  | -                                    |
| `setupFilesAfterEnv`     | DataModel paths to scripts that run after the framework, before each test file | -                                    |
| `showConfig`             | Print the config and exit (root only)                                          | -                                    |
| `silent`                 | Hide `print` and console output from tests (root only)                         | `false`                              |
| `slowTestThreshold`      | Seconds after which a test is reported as slow                                 | `5`                                  |
| `snapshotFormat`         | Snapshot serialization options                                                 | -                                    |
| `snapshotSerializers`    | DataModel paths to snapshot serializer modules                                 | -                                    |
| `testEnvironment`        | Test environment for the tests                                                 | -                                    |
| `testEnvironmentOptions` | Options for the test environment                                               | -                                    |
| `testFailureExitCode`    | Exit code when tests fail (root only)                                          | -                                    |
| `testMatch`              | Glob patterns for test files                                                   | `**/*.spec.ts`, `**/*.test.ts`, etc. |
| `testNamePattern`        | Run only tests whose full name matches this regex (root only)                  | -                                    |
| `testPathIgnorePatterns` | Regex patterns of test file paths to skip                                      | `/node_modules/`, `/dist/`, `/out/`  |
| `testPathPattern`        | Run only test files whose path matches this regex (root only)                  | -                                    |
| `testRegex`              | Regex patterns for test files                                                  | -                                    |
| `testTimeout`            | Max time for one test (ms)                                                     | `5000`                               |
| `timers`                 | Fake timers mode, such as `"real"` or `"fake"` (root only)                     | -                                    |
| `typecheck`              | Type test options. See [Type-Check Fields](#type-check-fields)                 | -                                    |
| `updateSnapshot`         | Update stored snapshots (root only)                                            | -                                    |
| `verbose`                | Show each test result (root only)                                              | `false`                              |

`exclude` is valid at root `test:` and in each project. It applies to single,
multi-project (`projects`) and `--workspace` runs. It does not apply to files
you name on the command line. Type tests use `typecheck.exclude` instead.

## Timeouts

Three budgets nest:

- **`test.testTimeout`** bounds one test.
- **`test.projectTimeout`** bounds one project in Roblox.
- **`timeout`** (root) bounds the whole run in Roblox. Its clock starts after
  the place boots.

`projectTimeout` has no CLI flag, and `--timeout` does not change it. Set it
under one project's `test` in `projects` to give a slow project more time. Set
it to `0` to turn it off. A project that runs out of time is reported as timed
out, and the run exits with code 1.

## Coverage Fields

Put these under `test: { ... }`. They are valid only at the root `test:`.

| Field                        | Purpose                                                                           | Default                                       |
| ---------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------- |
| `collectCoverage`            | Turn on coverage                                                                  | `false`                                       |
| `collectCoverageFrom`        | Globs of the files to include in coverage                                         | -                                             |
| `coverage`                   | Same as `collectCoverage`                                                         | -                                             |
| `coverageCopyIgnorePatterns` | Globs of files that a coverage run does not copy into the place                   | `**/*.d.ts`, `**/*.d.ts.map`, `**/*.luau.map` |
| `coverageDirectory`          | Output folder                                                                     | `"coverage"`                                  |
| `coveragePathIgnorePatterns` | Globs to exclude from coverage                                                    | test files, node_modules, rbxts_include       |
| `coverageReporters`          | Istanbul reporter list                                                            | `["text", "lcov"]`                            |
| `coverageThreshold`          | Min percentages (branches, functions, lines, statements). The run fails below one | -                                             |

## Extending Defaults

These fields can take a function `(defaults) => value`: `collectCoverageFrom`,
`coverageCopyIgnorePatterns`, `coveragePathIgnorePatterns`, `coverageReporters`,
`coverageThreshold`, `formatters`, `luauRoots`, `reporters`, `roots`,
`selectProjects`, `setupFiles`, `setupFilesAfterEnv`, `snapshotFormat`,
`snapshotSerializers`, `testMatch` and `testPathIgnorePatterns`. The function
gets the default value and returns the value to use. An array value replaces the
defaults.

```typescript
export default defineConfig({
	test: {
		coveragePathIgnorePatterns: (defaults) => {
			return [...defaults, "**/generated/**"];
		},
	},
});
```

## Type-Check Fields

Type Tests (`*.spec-d.ts`, `*.test-d.ts`) are configured under
`test: { typecheck: { ... } }`, valid at the root `test:` block and per-project.
Host-only: never forwarded to the Roblox runtime.

| Field                | Purpose                                                                                                           | Default |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- | ------- |
| `enabled`            | Enable Type Tests (the only gate; setting other fields does not auto-enable)                                      | `false` |
| `only`               | Run only Type Tests, skip Runtime Tests                                                                           | `false` |
| `include`            | Globs for Type Test files; when unset, derived from the project's runtime `include` (`.spec.`→`.spec-d.`)         | derived |
| `exclude`            | Globs to exclude from Type Test discovery                                                                         | -       |
| `tsconfig`           | Custom tsconfig for type testing (root-only in projects mode)                                                     | -       |
| `ignoreSourceErrors` | `false`: surface type errors in non-test source files; `true`: report only errors inside Type Test files          | `false` |
| `spawnTimeout`       | Milliseconds to wait for the tsgo process to start before the run throws; bounds startup only, not the type-check | `10000` |

The type pass runs concurrently with the Roblox run, as do multiple tsconfig
groups. The run-level `timeout` bounds the type-check itself.

tsgo type-checks the whole tsconfig program; the Type Test globs only select
which files are collected as Type Tests and how diagnostics are attributed.

The `--typecheck`, `--typecheckOnly`, and `--typecheckTsconfig` CLI flags map
onto `enabled`, `only`, and `tsconfig`.

## Example

```typescript
import { defineConfig } from "@isentinel/jest-roblox";

export default defineConfig({
	jestPath: "ReplicatedStorage/Packages/Jest",
	placeFile: "./game.rbxl",
	test: {
		projects: ["ReplicatedStorage/tests"],
	},
	timeout: 60000,
});
```

## Merge Behavior

Configuration is resolved in this order (later wins):

1. Built-in defaults
2. Extended config (`extends`)
3. Config file
4. CLI flags

In `--workspace` mode the root fields resolve per run and the rest per package;
see [workspace](workspace.md).
