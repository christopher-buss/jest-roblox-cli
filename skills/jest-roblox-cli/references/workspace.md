# Workspace mode

`--workspace` runs every package that carries a `jest.config.*` in one
invocation, staged into one synthesized place. Works on every backend:
`studio-cli` and `studio` run packages one at a time; Open Cloud shards them
across `--parallel` sessions.

## Selecting packages

| Command                                                       | Runs                                           |
| ------------------------------------------------------------- | ---------------------------------------------- |
| `jest-roblox --workspace`                                     | Every package                                  |
| `jest-roblox --workspace --packages @scope/a,@scope/b`        | Named packages                                 |
| `jest-roblox --workspace --affected-since main`               | Packages changed since a git ref               |
| `jest-roblox --workspace src/shared/dropdown.spec.ts`         | Only the package and projects owning that file |
| `jest-roblox --workspace --packages @scope/a,@scope/b --bail` | Stops at the first failing package             |

- `--packages`, `--affected-since`, and `--bail` require `--workspace`;
  `--packages` and `--affected-since` are mutually exclusive.
- A selection that matches nothing exits 2 (a configuration problem); an
  `--affected-since` that finds nothing exits 0 (a clean run).
- `--affected-since` delegates to `turbo` or `nx`. With Nx, each project's Nx
  name must equal its `package.json#name`, or the run fails with
  `Package "<name>" not found in workspace`.
- A positional file resolves against the current directory. A file no package
  owns is an error listing the include roots searched.
- `workspace.exclude` (globs from the workspace root) skips packages during
  enumeration; `--packages` still runs a package it excludes.
- `--bail` is not Jest's `test.bail`, which still counts failing suites inside
  one package.

## Package discovery

By default packages come from the pnpm workspace: the list pnpm records at
install time, falling back to `pnpm-workspace.yaml`. A package in a
dot-directory resolves only from the recorded list: run `pnpm install` after
adding one.

Without pnpm, declare a `workspace` block in a shared config that every package
`extends`:

```ts
export default defineConfig({
	workspace: {
		packages: ["packages/*"], // globs relative to root
		root: "../..", // relative to this file
	},
});
```

`root` and `packages` go together, and every package must inherit the same
values. Package names come from `package.json#name`, else the directory name.
From a directory with no resolvable jest config, pass
`--workspace-root <dir of shared config>`. `--affected-since` does not support
this source.

## Config resolution

The workspace-root config is not a source of truth for package behavior.

- **Run options** (`backend`, `color`, `formatters`, `gameOutput`, `outputFile`,
  `parallel`, `placeId`, `port`, `silent`, `studioPath`, `universeId`,
  `workspace.*`) resolve as CLI flag > unanimous per-package value
  > default. Packages that disagree fail the run.
- **Everything else** (`placeFile`, `timeout`, `jestPath`, `luauRoots`, `test:`
  fields, …) is read from each package's own config or the shared config it
  extends.

## Coverage

Every coverage field is read per package. Each package that sets its own
`collectCoverage` gets its own report in `<package>/<coverageDirectory>`, gated
by its own `coverageThreshold`. A package with no threshold is not gated, and
nothing is pooled across packages. A threshold without `collectCoverage` only
warns.

A package's `collectCoverageFrom` resolves against the package directory: write
`src/**/*.ts`, not `packages/foo/src/**/*.ts` (that matches nothing and passes
the threshold vacuously). A package with no `collectCoverageFrom` reports on,
and probes, everything under its `luauRoots`.

## Output files

| Field                        | Writes                                                              |
| ---------------------------- | ------------------------------------------------------------------- |
| `gameOutput`                 | One grouped file at the root: `[{ package, project, entries }]`     |
| `workspace.gameOutput: true` | One file per (package, project) under `.jest-roblox/output/`        |
| `outputFile`                 | One merged Jest result at the root                                  |
| `workspace.outputFile: true` | One result file per (package, project) under `.jest-roblox/output/` |

A failing package also prints its game output under its own section of the
terminal report.
