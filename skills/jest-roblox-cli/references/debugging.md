# Debugging

## Common Errors

| Symptom                                             | Cause                                                  | Fix                                                                                                                                                    |
| --------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| "Failed to find Jest instance in ReplicatedStorage" | jestPath not configured                                | Set `jestPath` in config to the DataModel path where the `Jest` module is located in your Rojo project tree (e.g. `"ReplicatedStorage/Packages/Jest"`) |
| "Failed to find Jest instance at path"              | jestPath doesn't match Rojo tree                       | Verify path matches your `*.project.json`                                                                                                              |
| "Failed to find service"                            | First segment of jestPath isn't a valid Roblox service | Check for typos (e.g. `ReplicatedStorage`, `ServerScriptService`)                                                                                      |
| "No projects configured"                            | Missing `projects` field                               | Set `projects` in jest.config.ts (e.g. `["ReplicatedStorage/tests"]`)                                                                                  |
| "Infinite yield detected"                           | WaitForChild for missing instance                      | Check DataModel paths align with Rojo project                                                                                                          |
| Wrong source locations in errors                    | Rojo project / source map mismatch                     | Check `rojoProject` path, verify rojo config matches compiled output                                                                                   |
| Luau runtime errors with no context                 | Need to see print/warn/error output                    | Use `--gameOutput <path>` to capture all Luau output                                                                                                   |
| "luauRoots must be relative paths"                  | Absolute path in config                                | Use relative paths for `luauRoots` or set relative `outDir` in tsconfig                                                                                |
| "No Rojo project found"                             | Can't auto-detect project file                         | Set `rojoProject` in config or add a `*.project.json` file                                                                                             |
| "loadstring() is not available"                     | LoadStringEnabled not set                              | Add `"LoadStringEnabled": true` to ServerScriptService.$properties in project.json                                                                     |
| "lute is required but was not found on PATH"        | Lute not installed                                     | Install lute via mise or rokit                                                                                                                         |
| "rojo was not found on PATH"                        | Rojo not installed (coverage and `studio-cli` need it) | Install rojo via mise, rokit, or aftman                                                                                                                |
| "Open Cloud credentials are required"               | `auto` found no Studio, or `--backend open-cloud`      | On a machine with Studio, set `studioPath`; otherwise set the Open Cloud env vars (see [backends](backends.md))                                        |
| "Studio did not start the run within Nms"           | `studio-cli`: likely Studio not logged in, or a modal  | Rerun with `--headed` and read the Studio log tail the error prints; raise `JEST_ROBLOX_STUDIO_BOOT_TIMEOUT` on a slow machine                         |
| "Execution timed out"                               | Open Cloud task never reached a final state            | Read the task state and suspects it prints; raise `--timeout`                                                                                          |
| "Execution was cancelled"                           | Open Cloud task cancelled externally                   | Check Roblox Open Cloud dashboard                                                                                                                      |
| "Studio plugin disconnected before sending results" | Attached `studio`: Studio closed mid-run               | Keep Studio open during test execution                                                                                                                 |
| "Jest exited before returning a result"             | The run exited writing no cause anywhere it was heard  | Read the report under it — see below                                                                                                                   |

## A run that came back with only an exit code

Jest exits through a shim that raises `Exited with code: N`, and the reason it
exited is written to `process.stdout` a moment earlier. The runners tap that
stream into Banner Output and surface it as the failure. When the tap caught
nothing there is no cause to show, and the failure reports what the host knows
instead:

```text
  FAIL  <exec-error>
Test suite failed to run

Jest exited before returning a result, and no cause was captured.

  Project      @scope/pkg › unit
  Phase        running Jest
  Test files   1 selected by the host
  Capture      stdout/stderr intercepted; Jest wrote nothing
  Game Output  14 lines captured; the last of them follow

    ...

Exited with code: 1
```

Read it row by row. **Phase** says how far the run got —
`staging the package into the DataModel`, `resolving the Jest module`,
`resolving project and setup-file instances`, or `running Jest`. **Test files**
is the host's own selection: zero there and an exit of 1 is the
`passWithNoTests` shape, but the report will not say so, because several other
failures exit the same way. **Capture** distinguishes a Jest that wrote nothing
from a tap that never went on; the latter is a fault in this CLI, not in the
project under test. **Game Output** is the wider LogService dump — an
intercepted `process.stdout` still delegates to `print`, so the line Jest exited
on usually appears in its tail even when Banner Output is empty.
`--gameOutput <path>` writes all of it.

## A run that wedged

A test that never yields is preempted by Roblox after about ten seconds, inside
Jest's own Promise executor. Jest's `testTimeout` fires into the same broken
run, circus never recovers, and the project is abandoned at its `projectTimeout`
— no test results, no error of its own.

The abandoned project reports the test it was in:

```text
 TIMEOUT  <exec-error>
Test suite timed out

Timed out after 60s, aborting tests. Raise test.projectTimeout. Last test seen: "wedge wedges without yielding" in ReplicatedStorage/PkgShared/wedge.spec (running for 52.3s)
```

The record is written on every circus boundary and never leaves the VM, so it
names the test rather than approximating it: the name Jest built, describe and
test joined by a space, at the spec's DataModel path rather than its source
path. The run also prints the sentence, which is where to look when the envelope
never comes back at all — a task that outran the Open Cloud deadline reports
`DEADLINE_EXCEEDED` and a tail of what the script printed.

Two other things it can say. `No test was running; the last to finish was …` is
a run that wedged between tests — a hook, a teardown, or the next file's
imports, so look just past the test it names. `No test was seen: …` is a run
that never reached a test file at all, and says why.

Read the wedged test's own last `print` next: it is in `--gameOutput`, ahead of
this line, and is usually the statement the test never returned from.

## Diagnostic Flags

| Flag                  | Purpose                                                            |
| --------------------- | ------------------------------------------------------------------ |
| `--verbose`           | See individual test results                                        |
| `--gameOutput <path>` | Capture all Luau print/warn/error to a file                        |
| `--no-coverage-cache` | Force a clean coverage re-instrumentation (skip incremental cache) |
| `--no-upload-cache`   | Always upload the place, even when its bytes are unchanged         |
| `--no-show-luau`      | Hide Luau code snippets in failure output                          |
| `--no-color`          | Disable colored output (useful for CI logs)                        |
| `--headed`            | Show the `studio-cli` Studio window to watch a hang                |

## General Approach

1. Start with `--verbose` to see which tests are running and failing
2. Use `--gameOutput game-output.log` to capture Luau runtime output (print,
   warn, error) that doesn't appear in test results
3. For source mapping issues, verify your `rojoProject` path and that the Rojo
   project tree matches the compiled output structure
4. For coverage issues, verify [lute](https://github.com/luau-lang/lute/) and
   rojo are on PATH

## Where a run is right now

Every step between the `RUN` header and the report announces itself:
`instrument`, `build place`, `upload`, `boot probe`, `bundle`, `run tests`. A
stage still marked `·` when the run ends is the one it died inside.

A terminal repaints one block with a running duration; a pipe or a CI log gets
one line as a stage opens and another as it closes. Set `TIMING` for the full
`[TIMING]` waterfall on stderr, which measures every phase rather than the six
worth naming.
