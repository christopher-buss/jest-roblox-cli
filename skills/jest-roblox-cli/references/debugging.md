# Debugging

## Common Errors

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Failed to find Jest instance in ReplicatedStorage" | jestPath not configured | Set `jestPath` in config to the DataModel path where the `Jest` module is located in your Rojo project tree (e.g. `"ReplicatedStorage/Packages/Jest"`) |
| "Failed to find Jest instance at path" | jestPath doesn't match Rojo tree | Verify path matches your `*.project.json` |
| "Failed to find service" | First segment of jestPath isn't a valid Roblox service | Check for typos (e.g. `ReplicatedStorage`, `ServerScriptService`) |
| "No projects configured" | Missing `projects` field | Set `projects` in jest.config.ts (e.g. `["ReplicatedStorage/tests"]`) |
| "Infinite yield detected" | WaitForChild for missing instance | Check DataModel paths align with Rojo project |
| "No backend available" | No Studio plugin, no env vars | Set Open Cloud env vars or open Studio with plugin |
| Stale/cached results | Old place file cached | Use `--no-cache` to force re-upload |
| Wrong source locations in errors | Rojo project / source map mismatch | Check `rojoProject` path, verify rojo config matches compiled output |
| Luau runtime errors with no context | Need to see print/warn/error output | Use `--gameOutput <path>` to capture all Luau output |
| "luauRoots must be relative paths" | Absolute path in config | Use relative paths for `luauRoots` or set relative `outDir` in tsconfig |
| "No Rojo project found" | Can't auto-detect project file | Set `rojoProject` in config or add a `*.project.json` file |
| "loadstring() is not available" | LoadStringEnabled not set | Add `"LoadStringEnabled": true` to ServerScriptService.$properties in project.json |
| "lute is required for instrumentation but was not found on PATH" | Lute not installed | Install lute via mise or rokit |
| "rojo is required for --coverage but was not found on PATH" | Rojo not installed | Install rojo via mise, rokit, or aftman |
| "Rate limited by Open Cloud API after multiple retries" | API rate limit | Wait and retry, or reduce poll frequency via `--pollInterval` |
| "Execution timed out" | Test exceeded timeout | Increase `--timeout` value |
| "Execution was cancelled" | Task cancelled externally | Check Roblox Open Cloud dashboard |
| "Studio plugin disconnected before sending results" | Studio closed mid-run | Keep Studio open during test execution |

## Diagnostic Flags

| Flag | Purpose |
|------|---------|
| `--verbose` | See individual test results |
| `--gameOutput <path>` | Capture all Luau print/warn/error to a file |
| `--no-cache` | Force re-upload place file (rule out stale cache) |
| `--no-show-luau` | Hide Luau code snippets in failure output (useful for AI consumption) |
| `--compact` | Token-efficient output format for AI agents |
| `--no-color` | Disable colored output (useful for CI logs) |

## General Approach

1. Start with `--verbose` to see which tests are running and failing
2. Use `--gameOutput game-output.log` to capture Luau runtime output (print,
   warn, error) that doesn't appear in test results
3. If results seem stale, use `--no-cache` to rule out cached place files
4. For source mapping issues, verify your `rojoProject` path and that the Rojo
   project tree matches the compiled output structure
5. For coverage issues, verify [lute](https://github.com/luau-lang/lute/) is
   installed and on PATH
