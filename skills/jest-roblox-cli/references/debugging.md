# Debugging

## Common Errors

| Symptom                                                          | Cause                                                  | Fix                                                                                                                                                    |
| ---------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| "Failed to find Jest instance in ReplicatedStorage"              | jestPath not configured                                | Set `jestPath` in config to the DataModel path where the `Jest` module is located in your Rojo project tree (e.g. `"ReplicatedStorage/Packages/Jest"`) |
| "Failed to find Jest instance at path"                           | jestPath doesn't match Rojo tree                       | Verify path matches your `*.project.json`                                                                                                              |
| "Failed to find service"                                         | First segment of jestPath isn't a valid Roblox service | Check for typos (e.g. `ReplicatedStorage`, `ServerScriptService`)                                                                                      |
| "No projects configured"                                         | Missing `projects` field                               | Set `projects` in jest.config.ts (e.g. `["ReplicatedStorage/tests"]`)                                                                                  |
| "Infinite yield detected"                                        | WaitForChild for missing instance                      | Check DataModel paths align with Rojo project                                                                                                          |
| "No backend available"                                           | No Studio plugin, no env vars                          | Set Open Cloud env vars or open Studio with plugin                                                                                                     |
| Wrong source locations in errors                                 | Rojo project / source map mismatch                     | Check `rojoProject` path, verify rojo config matches compiled output                                                                                   |
| Luau runtime errors with no context                              | Need to see print/warn/error output                    | Use `--gameOutput <path>` to capture all Luau output                                                                                                   |
| "luauRoots must be relative paths"                               | Absolute path in config                                | Use relative paths for `luauRoots` or set relative `outDir` in tsconfig                                                                                |
| "No Rojo project found"                                          | Can't auto-detect project file                         | Set `rojoProject` in config or add a `*.project.json` file                                                                                             |
| "loadstring() is not available"                                  | LoadStringEnabled not set                              | Add `"LoadStringEnabled": true` to ServerScriptService.$properties in project.json                                                                     |
| "lute is required for instrumentation but was not found on PATH" | Lute not installed                                     | Install lute via mise or rokit                                                                                                                         |
| "rojo is required for --coverage but was not found on PATH"      | Rojo not installed                                     | Install rojo via mise, rokit, or aftman                                                                                                                |
| "Rate limited by Open Cloud API after multiple retries"          | API rate limit                                         | Wait and retry; the Open Cloud client backs off automatically                                                                                          |
| "Execution timed out"                                            | Test exceeded timeout                                  | Increase `--timeout` value; on Open Cloud the error also names the last test the runtime reached (see below)                                           |
| "Execution was cancelled"                                        | Task cancelled externally                              | Check Roblox Open Cloud dashboard                                                                                                                      |
| "Studio plugin disconnected before sending results"              | Studio closed mid-run                                  | Keep Studio open during test execution                                                                                                                 |

## A run that wedged

A test that never yields is not preempted by Roblox, and it starves every other
coroutine — Jest's own `testTimeout` included. The task returns no output, no
error and no state, so Open Cloud has nothing to report and neither did this CLI
before per-test heartbeats.

Every Open Cloud run now writes one heartbeat record per task into a per-run
MemoryStore sorted map, naming the test the run had reached. The host reads it
only after a poll timeout, and appends what it found:

```text
Execution timed out: Roblox never reported a terminal state ...
  The task never came back, and the last thing the Roblox VM published was:
    ReplicatedStorage/shared/wedge.spec › wedges › never returns — started 42.0s in, never completed
  The runtime publishes about one record a second, so the wedge is that
  test or one shortly after it in that file: a test that never yields
  starves every other coroutine, so nothing later could publish.
```

Writes are throttled to roughly one a second per task, so the _file_ is exact
while the _test_ is only a lower bound: a test that began just after the last
record landed leaves none of its own. The banner hedges the same way whether the
record says `started` or `completed`, because both cases allow a later test in
that file to be the one that wedged.

A sharded run shares one map across its tasks, so the banner lists a last record
per task and says only that at least one of them never came back — a task that
finished normally leaves a record too, and nothing correlates a record back to
the task that wrote it.

Nothing here fails a run on its own: a key without the `memory-store.sorted-map`
scopes simply reports the bare timeout.

## Diagnostic Flags

| Flag                  | Purpose                                                               |
| --------------------- | --------------------------------------------------------------------- |
| `--verbose`           | See individual test results                                           |
| `--gameOutput <path>` | Capture all Luau print/warn/error to a file                           |
| `--no-coverage-cache` | Force a clean coverage re-instrumentation (skip incremental cache)    |
| `--no-upload-cache`   | Always upload the place, even when its bytes are unchanged            |
| `--no-show-luau`      | Hide Luau code snippets in failure output (useful for AI consumption) |
| `--formatters agent`  | Token-efficient output format for AI agents                           |
| `--no-color`          | Disable colored output (useful for CI logs)                           |

## General Approach

1. Start with `--verbose` to see which tests are running and failing
2. Use `--gameOutput game-output.log` to capture Luau runtime output (print,
   warn, error) that doesn't appear in test results
3. For source mapping issues, verify your `rojoProject` path and that the Rojo
   project tree matches the compiled output structure
4. For coverage issues, verify [lute](https://github.com/luau-lang/lute/) is
   installed and on PATH

## Where a run is right now

Every step between the `RUN` header and the report announces itself:
`instrument`, `build place`, `upload`, `boot probe`, `run tests`,
`collect results`, `coverage`. A stage still marked `·` when the run ends is the
one it died inside.

A terminal repaints one block with a running duration; a pipe or a CI log gets
one line as a stage opens and another as it closes. Set `TIMING` for the full
`[TIMING]` waterfall on stderr, which measures every phase rather than the six
worth naming.
