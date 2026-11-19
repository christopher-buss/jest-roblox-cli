# Partial runs

`jest-roblox related <files>` runs only the tests that reach the given source
files through `require` or `TS.import`. `jest-roblox --changed [ref]` does the
same for the files changed in git.

```bash
jest-roblox related src/util.luau src/inventory/init.luau
jest-roblox --changed
jest-roblox --changed main
```

- Bare `--changed` takes the staged, unstaged and untracked files against
  `HEAD`. With a ref, it also takes every file committed since the merge base of
  that ref and `HEAD`.
- A deleted module selects every test that required it.
- Instance paths and `TS.import` resolve through the Rojo project.
- A `.ts` file stands for its compiled `.luau` module, so compile first.
- A run with no test that reaches the files passes, as with `--passWithNoTests`.
- `related` also works with `--workspace`.
- To filter to a test file named `related`, write `./related`.

## When every test runs

The run cannot always tell which tests a file reaches. Every test runs when:

- a given file matches `forceRerunTriggers` (the lockfiles by default);
- a given file is in the project root or the folders your Rojo project maps into
  the place, and is not a Luau module or a compiled `.ts` file;
- a test reaches a `require` that the CLI cannot follow (dynamic or unresolved);
- the CLI cannot read a test file.

With `--workspace`, these rules do not apply: only the tests that a file reaches
run, and `forceRerunTriggers` does nothing.

A file outside the project root, the folders your Rojo project maps into the
place and `forceRerunTriggers` is ignored. `forceRerunTriggers` globs are
relative to the nearest folder with a `pnpm-workspace.yaml`, `turbo.json` or
`nx.json`, else to the project root.

## Coverage

With `--coverage`, both modes report and apply `coverageThreshold` only to the
changed or related source files.
