# Coverage

Enable with `--coverage`. The pipeline: instruments compiled Luau via
[lute](https://github.com/luau-lang/lute/) into a shadow copy
(`.jest-roblox/coverage/`) → rewrites the Rojo project to point at it → builds
the place with `rojo build` → runs tests → collects hit counts → maps Luau spans
back to source via source maps → generates reports and checks thresholds.

## Prerequisites

[Lute](https://github.com/luau-lang/lute/) and [rojo](https://rojo.space) on
PATH, typically installed via `mise` or `rokit`.

Run on `studio-cli` or `open-cloud`. The attached `studio` backend builds the
coverage place to `.jest-roblox/place/`, which is not the place Studio serves.

## CLI Flags

| Flag                  | Purpose                                                                                                                      | Default        |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `--coverage`          | Enable coverage collection                                                                                                   | `false`        |
| `--no-coverage`       | Disable coverage for this run, overriding `collectCoverage` in config (skips instrumentation, so it runs at plain-run speed) | —              |
| `--coverageDirectory` | Output directory                                                                                                             | `"coverage"`   |
| `--coverageReporters` | Reporter list                                                                                                                | `text`, `lcov` |

Supported reporters: `clover`, `cobertura`, `html`, `html-spa`, `json`,
`json-summary`, `lcov`, `lcovonly`, `none`, `teamcity`, `text`, `text-lcov`,
`text-summary`.

Config fields live under `test:` (see [configuration](configuration.md));
`luauRoots` stays at config root and must be a relative path.

## Agent mode

With the `agent` formatter (the default inside an AI agent, detected via
`std-env`) the terminal text reporters trim to minimize tokens:

- `skipFull` hides fully-covered files, so the table lists only what still needs
  tests, with their uncovered line numbers.
- The `flat` summarizer disambiguates same-named files by path suffix
  (`...nt/ui/index.ts`) instead of repeating `index.ts`.
- Fully covered → one line: `Coverage: 100% (N files)`.
- Partially covered → the trimmed table plus a totals line with raw counts:
  `Coverage: 84% stmts (16/19) | 100% branch (4/4) | …`.

File reporters (`lcov`, `json`, …) are unaffected. `--verbose` opts out.

## Thresholds

Configure in `jest.config.ts`; the run exits non-zero if any metric falls below
its configured value:

```typescript
const config = {
	test: {
		coverageThreshold: {
			branches: 70,
			functions: 80,
			statements: 80,
		},
	},
};
```

Available metrics: `statements`, `branches`, `functions`, `lines`.

## The coverage universe

`collectCoverageFrom` and `coveragePathIgnorePatterns` narrow the universe: the
files the report lists and the threshold judges.

`coveragePathIgnorePatterns` matches the **TypeScript source path** with
substring semantics (Jest-style), so a file-level glob like `**/index.ts`
excludes barrel files at any depth, even when no test requires them.

The universe also decides which files get probes at all. A file outside it is
mirrored into the shadow directory verbatim instead of instrumented, so the
place stays loadable but the run never carries hit counts the report would
discard. That matters on Open Cloud, which rejects a task returning more than 4
MiB: a place probed across its whole source tree can spend most of that budget
on files no report asks about. Narrowing `collectCoverageFrom` is the lever;
`luauRoots` and `coveragePathIgnorePatterns` cut whole roots the same way.

A multi-project run with no `collectCoverageFrom` derives the universe from each
project's `include` globs. Paths anchor on the invocation directory. Workspace
mode differs; see [workspace](workspace.md#coverage).

<!-- prettier-ignore -->
> [!WARNING]
> A universe that matches no file yields an empty report, and an empty report
> passes `coverageThreshold` vacuously: there is no file to fall short. Check
> the report lists the files you expect before trusting a threshold.

Changing either set of globs, or the `rootDir` they anchor to, invalidates the
incremental coverage cache: the shadow directory still holds probed copies of
files the new universe excludes, and no source hash would notice.
`--no-coverage-cache` forces a clean re-instrumentation.

## Generated Files

The `.jest-roblox/coverage/` directory holds instrumented Luau files and
manifests. Add the umbrella to `.gitignore`:

```gitignore
.jest-roblox/
```
