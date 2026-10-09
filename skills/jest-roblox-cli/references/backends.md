# Backends

| Backend    | Flag                   | Requirements                                                         | Coverage |
| ---------- | ---------------------- | -------------------------------------------------------------------- | -------- |
| Auto       | `--backend auto`       | (default) see below                                                  | —        |
| studio-cli | `--backend studio-cli` | Roblox Studio installed and logged in, `rojo` on PATH                | yes      |
| Open Cloud | `--backend open-cloud` | `ROBLOX_OPEN_CLOUD_API_KEY`, `ROBLOX_UNIVERSE_ID`, `ROBLOX_PLACE_ID` | yes      |
| Studio     | `--backend studio`     | Studio open with the jest-roblox plugin installed                    | no       |

## Auto

`auto` picks `studio-cli` when Studio is installed, otherwise `open-cloud`.
Studio counts as installed when `studioPath` (or `--studioPath`,
`JEST_ROBLOX_STUDIO_PATH`) is set or discovery finds it. Discovery covers
Windows and macOS only; on Linux or WSL, `auto` picks `open-cloud` unless a path
is set.

The pick is made once, before the run. A failed `studio-cli` run fails the run,
and a wrong `studioPath` fails at launch: neither moves to Open Cloud. `auto`
never picks the attached `studio` backend.

## studio-cli

Owns the whole Studio lifecycle: builds its own place, launches an isolated
hidden Studio, runs the tests, and quits. No API key, no upload, no plugin to
install: it builds and installs its own plugin on first use after an upgrade.
Studio windows already open stay untouched.

- Serial: one session, `--parallel` ignored.
- `--coverage` works and matches Open Cloud's report semantics.
- `timeout` starts once Studio has opened the place, so a slow launch does not
  eat the test budget. The launch has its own window, raised with
  `JEST_ROBLOX_STUDIO_BOOT_TIMEOUT` (ms).
- `--headed` shows the Studio window to watch a hang. CLI-only.
- A CI machine with Studio installed would pick this backend; pass
  `--backend open-cloud` to keep CI remote.

## Open Cloud

Uploads the place file and runs it as a Luau execution task. Prefix any of the
three env vars with `JEST_` (e.g. `JEST_ROBLOX_PLACE_ID`) to override the
unprefixed value when other tooling claims the generic names. `--apiKey`,
`--universeId`, and `--placeId` also work, but leak into process listings.

The upload is skipped when the place bytes are unchanged
(`.jest-roblox/upload-cache.json`); `--no-upload-cache` forces it. Each new
version is proved by a boot probe before any test task; a version that cannot
boot exits 2 rather than failing tests; raise `bootProbeTimeout` (default 90s)
for a slow boot.

### API key scopes

A missing scope surfaces as a `PermissionError` naming it.

| Scope                                              | When                                                     |
| -------------------------------------------------- | -------------------------------------------------------- |
| `universe-places:write`                            | Always                                                   |
| `universe.place.luau-execution-session:write`      | Always                                                   |
| `memory-store.queue:add` / `:dequeue` / `:discard` | Sharded `--workspace` run (`--parallel auto` or above 1) |
| `memory-store.sorted-map:read` / `:write`          | Live result streaming (default; see below)               |

Without the queue scopes a sharded run warns and falls back to static buckets.
Streaming is off for `--silent`, `--formatters json`, and `--formatters agent`
(unless `--verbose`); `--formatters github-actions` streams.

`--parallel [n]` runs `n` concurrent sessions (`auto` = `min(jobs, 3)`). Each
costs one task create against Roblox's create limit.

## Studio

Attaches to an open Studio over WebSocket (`port`, default `3001`) through the
jest-roblox plugin. Studio exposes no open-place identity, so run one repo at a
time.

Every installed copy of the plugin opens its own connection; the CLI dispatches
to the one announcing a matching protocol version. When none matches, the run
stops and names every connection, even with Open Cloud credentials set. Remove
the stale `JestRobloxRunner.rbxm` copies from the Studio plugins folder.

## Experimental VM parallelism

`--experimental-vm-parallel [n]` runs a multi-project suite across `n` Luau VMs
(`Actor` hosts) inside one Studio session. Bare, it uses one VM per project. The
plugin ships four hosts; an explicit `n` above four is rejected. Both Studio
backends support it; Open Cloud rejects it (use `--parallel` there).

In workspace mode packages still run in turn; a package's projects split across
the VMs. Single-project packages gain nothing.

- **Shared DataModel.** Projects that mutate `Workspace`, `ReplicatedStorage`,
  `Players`, or a DataStore mock conflict when they overlap. Enable it only for
  DataModel-disjoint suites.
- **Batch-scoped game output.** Overlapping projects cannot be told apart in
  `LogService`, so `--gameOutput` writes one group labelled
  `"project": "(all projects)"`, `"scope": "batch"`.
- Projects whose mounts nest (`ReplicatedStorage` and `ReplicatedStorage/Foo`)
  share a host and run in turn.
