# Backend Selection

`--backend auto` (default) resolves like this:

1. Probe for Studio plugin on WebSocket port 3001 (500ms timeout)
2. If plugin detected → use Studio. If Open Cloud credentials also exist, Studio
   failures fall back to Open Cloud automatically.
3. If no plugin → use Open Cloud (requires all three env vars below)
4. If neither → error: "No backend available"

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

Execution tasks then run _unpinned_ so they can land on a warm server holding
the latest saved version; an injected guard compares `game.PlaceVersion` against
the version this run uploaded or reused, and bails with a sentinel naming the
version it booted instead. Raced tasks are retried once pinned to that version —
correct by construction, but a cold place boot. This guard is also what makes
the upload cache safe: a stale entry can only cause the sentinel, never a run
against the wrong source. The poll cadence for task completion is managed
internally by the Open Cloud client and is not user-configurable.

The version the sentinel names is the only way to tell a stale cache entry from
a genuine concurrent upload — Open Cloud will not say which version is head. A
task booting past a _reused_ version proves the entry is behind head, so the run
deletes it from `.jest-roblox/upload-cache.json` and the next run uploads again.
Without that, the entry would be stuck: a cache hit never uploads, so the
version it names could never become head again, and every later run would pay a
pinned cold boot. A raced run therefore mutates the cache file, and the upload
that follows on the next run is expected, not a cache fault.

## Studio

Connects to a locally running Roblox Studio instance via WebSocket. Requires the
jest-roblox Studio plugin to be installed. The plugin listens on the configured
port (default: 3001) and executes tests when the CLI connects.

If Studio is busy (e.g. a previous play session is still running), and Open
Cloud credentials are available, the CLI automatically falls back to Open Cloud.
