# live-place fixture

Pre-built Roblox place file for the live OCALE e2e tests in
`tools/jest-roblox-cli/test/e2e/live/`.

## What is pre-built

The committed `game.rbxl` is consumed **only** by the contract test
(`test/e2e/live/contract.spec.ts`), which uploads it directly as a sealed binary
to verify Open Cloud's response shape. No CLI subprocess, no Rojo at test time.

The pipeline tests (`test/e2e/live/pipeline.spec.ts`) run the full CLI pipeline
against the fixture. The CLI's project layout writes per-project stubs
into the rojo source tree and rebuilds the rbxl. That rebuild needs `out/`
(compiled Luau and its `.luau.map` source maps) and `include/` (rbxts
runtime). Both are committed, so no test run compiles TypeScript.

Source files (`src/`, `default.project.json`, `tsconfig.*.json`, `package.json`)
live alongside the compiled output so both can be rebuilt out-of-band.

## Layout

- Two Rojo mounts so `workspace/`-level multi-root assertions have something to
  merge:
  - `ReplicatedStorage.PkgShared` <- `out/shared/`
  - `ServerScriptService.PkgServer` <- `out/server/`
- One passing `.spec.ts` on the shared mount and four on the server mount
  (`server-thing` plus three same-basename `index.spec` files), so:
  - The both-mounts run asserts "8 passed".
- No spec holds the CPU for long. An Open Cloud server kept near-saturated for
  about 14.5 s stops without ever failing the task, so the run stalls as
  `PROCESSING`.
  - The namesake run narrows to "1 passed" out of the three that share a
    basename.

## Versions baked into the committed `game.rbxl`

- Rojo: `7.7.0-rc.1`
- `@rbxts/jest` runtime: `catalog:test` (see `pnpm-workspace.yaml`)

## How to rebuild

Run from this directory (`tools/jest-roblox-cli/test/e2e/fixtures/live-place`):

```sh
pnpm install              # ensure linked workspace deps
sloptor build -p tsconfig.lib.json --type game
rojo build default.project.json -o game.rbxl
```

[sloptor](https://github.com/howmanyslop/sloptor) compiles the sources; any
roblox-ts compiler that writes `.luau.map` source maps works. Commit `out/`,
`include/`, and `game.rbxl`; `.gitignore` drops the compiler metadata. Run
the compile after any change to the fixture sources, and the `rojo build` when
the runtime or Rojo changes too.

## Notes for future contributors

- This fixture is intentionally NOT built in CI. The `nx` block in
  `package.json` overrides every inferred target (`build`, `test`, `typecheck`,
  `build-test`, `lint`) with `nx:noop` so `nx affected` skips it entirely.
- ESLint already ignores `**/fixtures/**/*` for `jest-roblox-cli`, so source
  files here aren't linted.
- `default.project.json` mounts the **local** `node_modules/@rbxts` (not the
  workspace-root path) so the compiler's rojo-resolver matches the symlinked
  layout.
  Switching to the workspace path causes a "Could not find Rojo data" diagnostic
  because the resolver looks up file paths relative to the project root, not the
  realpath through pnpm's `.pnpm/` store.
- The `@rbxts-js` mount uses the workspace's generated
  `node_modules/@rbxts-js.project.json`. Root `postinstall` regenerates it from
  pnpm's package map.
- `tsconfig.json` sets `"nx": { "addTypecheckTarget": false }` so the
  `@nx/js/typescript` plugin does not produce a `typecheck` target either.
