# live-place fixture

Pre-built Roblox place file for the live OCALE e2e tests in
`tools/jest-roblox-cli/test/e2e/{contract,project,workspace}`.

## What's pre-built vs. rebuilt at test time

The committed `game.rbxl` is consumed **only** by the contract test
(`test/e2e/contract/open-cloud-contract.spec.ts`), which uploads it directly
as a sealed binary to verify Open Cloud's response shape. No CLI subprocess,
no Rojo at test time.

The project (`test/e2e/project/`) and workspace (`test/e2e/workspace/`)
tests run the full CLI pipeline against the fixture. The CLI's
`runMultiProject` path writes per-project stubs into the rojo source tree
and rebuilds the rbxl — that rebuild needs `out/` (compiled Luau) and
`include/` (rbxts runtime) to exist. Both are gitignored regenerated
artifacts, so the live vitest project's `globalSetup` (`global-setup.ts`)
invokes `rbxtsc` on demand. Sentinel-cached on `out/shared/example.luau`,
so successive runs in the same workspace skip recompilation.

Source files (`src/`, `default.project.json`, `tsconfig.*.json`,
`package.json`) live alongside `game.rbxl` so the binary can be rebuilt
out-of-band when the contract test's pre-built copy needs refreshing
(jest-roblox runtime upgrades, rojo bumps).

## Layout

- Two Rojo mounts so `workspace/`-level multi-root assertions have something
  to merge:
  - `ReplicatedStorage.PkgShared` <- `out/shared/`
  - `ServerScriptService.PkgServer` <- `out/server/`
- One passing `.spec.ts` per mount, so:
  - Contract/project tests assert "1 passed" against either mount.
  - Workspace tests assert "2 passed" across both mounts.

## Versions baked into the committed `game.rbxl`

- Rojo: `7.7.0-rc.1`
- `@rbxts/jest` runtime: `catalog:test` (see `pnpm-workspace.yaml`)
- `@isentinel/roblox-ts`: `workspace:*`

## How to rebuild

Run from this directory (`tools/jest-roblox-cli/test/e2e/fixtures/live-place`):

```sh
pnpm install              # ensure linked workspace deps
pnpm rbxtsc -p tsconfig.lib.json --type game
rojo build default.project.json -o game.rbxl
```

`out/` and `include/` are gitignored; only the resulting `game.rbxl` is
committed. Rebuild only when the runtime, Rojo, or the fixture sources change.

## Notes for future contributors

- This fixture is intentionally NOT built in CI. The `nx` block in
  `package.json` overrides every inferred target (`build`, `test`, `typecheck`,
  `build-test`, `lint`) with `nx:noop` so `nx affected` skips it entirely.
- ESLint already ignores `**/fixtures/**/*` for `jest-roblox-cli`, so source
  files here aren't linted.
- `default.project.json` mounts the **local** `node_modules/@rbxts` (not the
  workspace-root path) so `rbxtsc`'s rojo-resolver matches the symlinked
  layout. Switching to the workspace path causes a "Could not find Rojo data"
  diagnostic because the resolver looks up file paths relative to the project
  root, not the realpath through pnpm's `.pnpm/` store.
- `tsconfig.json` sets `"nx": { "addTypecheckTarget": false }` so the
  `@nx/js/typescript` plugin does not produce a `typecheck` target either.
