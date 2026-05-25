# Backend Selection

`--backend auto` (default) resolves like this:

1. Probe for Studio plugin on WebSocket port 3001 (500ms timeout)
2. If plugin detected → use Studio. If Open Cloud credentials also exist, Studio
   failures fall back to Open Cloud automatically.
3. If no plugin → use Open Cloud (requires all three env vars below)
4. If neither → error: "No backend available"

| Backend | Flag | Requirements |
|---------|------|--------------|
| Auto | `--backend auto` | (default) |
| Open Cloud | `--backend open-cloud` | `ROBLOX_OPEN_CLOUD_API_KEY`, `ROBLOX_UNIVERSE_ID`, `ROBLOX_PLACE_ID` |
| Studio | `--backend studio` | Studio open with jest-roblox plugin installed |

## Open Cloud

Requires three environment variables. The CLI uploads the place file to Roblox
via the Open Cloud API, creates a Luau execution task, polls for completion, and
parses the JSON result.

Every invocation uploads the place file fresh — Open Cloud has no read endpoint
to verify a previously-uploaded version is still current, so caching is unsafe
when a place ID is shared across worktrees. The poll cadence for task completion
is managed internally by the Open Cloud client and is not user-configurable.

## Studio

Connects to a locally running Roblox Studio instance via WebSocket. Requires the
jest-roblox Studio plugin to be installed. The plugin listens on the configured
port (default: 3001) and executes tests when the CLI connects.

If Studio is busy (e.g. a previous play session is still running), and Open
Cloud credentials are available, the CLI automatically falls back to Open Cloud.
