# Backend Selection

`--backend auto` (default) resolves like this:

1. Probe for Studio plugins on WebSocket port 3001 (500ms timeout)
2. If a connection announces this CLI's protocol version → use Studio. If Open
   Cloud credentials also exist, Studio failures fall back to Open Cloud
   automatically.
3. If plugins connected but none announced a matching version → error naming
   every connection, even when credentials exist. Studio runs every installed
   copy, so this is usually a stale `JestRobloxRunner.rbxm` left in the plugins
   folder.
4. If no plugin → use Open Cloud (requires all three env vars below)
5. If neither → error: "No backend available"

| Backend    | Flag                   | Requirements                                                         |
| ---------- | ---------------------- | -------------------------------------------------------------------- |
| Auto       | `--backend auto`       | (default)                                                            |
| Open Cloud | `--backend open-cloud` | `ROBLOX_OPEN_CLOUD_API_KEY`, `ROBLOX_UNIVERSE_ID`, `ROBLOX_PLACE_ID` |
| Studio     | `--backend studio`     | Studio open with jest-roblox plugin installed                        |

## Open Cloud

Requires three environment variables. The CLI uploads the place file to Roblox
via the Open Cloud API, creates a Luau execution task, polls for completion, and
parses the JSON result.

An invocation uploads the place file only when its bytes changed. The version a
set of bytes got is recorded in `.jest-roblox/upload-cache.json`, and an
unchanged build reuses it — an upload is the only thing measured to precede a
cold place boot (~22s against ~3s), so skipping it keeps the fast path.
`--no-upload-cache` forces the upload.

The place it uploads holds the run's code, and every task, the boot probe and
the tests alike, is submitted to the exact version that upload returned, never
to head. A shared place can be saved over by another run at any moment, so the
version is the only thing that names this run's bytes. A pinned task may miss
the warm-server pool and pay a cold place boot. This is also what makes the
upload cache safe: a reused version names the bytes that were hashed, whatever
head holds now. A version Open Cloud no longer serves comes back as a 404, which
drops the cache entry.

A fresh version is proved by the boot probe before any test task: a probe that
never finishes gets one retry, and a second loss stops the run as boot
unverified (exit code 2), not as a test failure. Only a completed probe is
cached, so an unchanged build on the same place skips it. The poll cadence for
task completion is managed internally by the Open Cloud client and is not
user-configurable.

No option ships the code beside a code-free place: that transport stays inactive
until an exclusive-place allocator exists.

## Studio

Connects to a locally running Roblox Studio instance via WebSocket. Requires the
jest-roblox Studio plugin to be installed. The plugin listens on the configured
port (default: 3001) and executes tests when the CLI connects.

Studio runs every plugin in the plugins folder, so several installed copies open
several connections. Each announces
`{ protocolVersion, pluginVersion, pluginName }` on open, and the CLI dispatches
`run_tests` to the one whose protocol matches — never to all of them.
Broadcasting is what used to let a stale copy decide the run: refusing a version
costs nothing while running the suite takes seconds, so the refusal always
arrived first.

If Studio is busy (e.g. a previous play session is still running), and Open
Cloud credentials are available, the CLI automatically falls back to Open Cloud.
