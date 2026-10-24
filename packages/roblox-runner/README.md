# @isentinel/roblox-runner

Node transport and scheduling primitives for running Luau tasks through Roblox
Open Cloud: place uploads, task submission, result recovery and MemoryStore
coordination. It runs on Node >=24.12 as ESM. jest-roblox-cli uses it.

## Use

The package is not published to npm. Packages in the same workspace depend on it
by name and import `@isentinel/roblox-runner` or
`@isentinel/roblox-runner/testing`.

Open Cloud operations require an API key authorized for the target
universe/place and the operations used. Task execution needs Luau Execution
enabled on the target place. Place upload, MemoryStore and MessagingService
operations need their corresponding API key permissions; publishing messages
needs `universe-messaging-service:publish`.

```ts
import { OcaleRunner, resolveCredentials } from "@isentinel/roblox-runner";

const credentials = resolveCredentials();
const runner = new OcaleRunner(credentials);
const { versionNumber } = await runner.uploadPlaceAsync({
	placeFilePath: "./test-place.rbxl",
});
const result = await runner.executeScriptAsync({
	placeVersion: versionNumber,
	script: "return 'hello from Roblox'",
	timeout: 30_000,
});
console.log(result.outputs);
```

`resolveCredentials` reads `ROBLOX_OPEN_CLOUD_API_KEY`, `ROBLOX_UNIVERSE_ID` and
`ROBLOX_PLACE_ID`. Explicit `overrides` win, followed by variables with the
optional `envPrefix`, ordinary environment variables, then place/universe
`defaults`. Whitespace-only values count as missing. Defaults never supply an
API key. Missing credentials throw a message naming the required variables.

`uploadPlaceAsync` saves by default; `publish: true` publishes. `.rbxlx` files
use XML format; other extensions use binary format. `uploadBinaryInputAsync`
allocates a slot and uploads a `Uint8Array`, returning a resource `path` that
`executeScriptAsync` accepts as `binaryInput`. Execution returns stringified
`outputs`, `durationMs` and terminal-task evidence.

## Deadlines and recovery

All host budgets use milliseconds. Roblox's script timeout is capped at 300
seconds. Its clock starts after place startup, so the default poll budget
includes a boot allowance. An explicit `pollBudget` overrides the observation
budget. `submitBudget` limits submission inactivity; `submitCapacityBudget` adds
a bounded allowance for capacity and SDK admission waits.
`maximumSubmitDuration` computes their combined bound when one is configured.

Submission failure throws `TaskSubmitError`; a quota refusal adds
`TaskQuotaError.evidence`. A task with no terminal result throws
`TaskStallError`, an `ExecutionTimeoutError` with diagnostic evidence and
`readResultAsync(signal?)`. Recovery polls the original task. A timeout does not
prove whether the script started, and resubmission can duplicate work.
`onSubmitted` runs after acceptance; `observationSignal` stops observation.
Cancellation of observation cannot cancel a task already accepted by Roblox. Use
`isSubmitIdempotent` only when duplicate execution is safe.

`placeIdentityGuardSource` emits a Luau guard for an expected place version or
content stamp. Put it before work starts; `readRefusedPlaceVersion` recognizes
its refusal. The `/testing` entry point exposes `formatPlaceMismatch` and
`PLACE_MISMATCH` for fake task responses using the same wire format.

## Shared work and cleanup

- `createWorkQueueWriter` encodes work; `createJsonWorkQueueWriter<T>` accepts
  JSON-compatible work directly. `enqueueAsync` optionally takes `ttlMs`.
- `createWorkQueueReader` decodes claimed work.
  `claimAsync(count, invisibilityMs)` returns `items` and an async `commit` that
  acknowledges the claim. An empty queue returns an empty batch.
- `createWorkQueueHost` also provides `acknowledgeAsync(receipt)` for protocols
  that receive opaque worker receipts.
- `SortedMapInbox<T>` lists decoded entries with IDs and deletes consumed items.
  `ProgressMap<T>` provides the progress-oriented wrapper.
- `runTaskPool` distributes slots across places, capped at ten per place,
  replenishes tasks until `isDone`, and reports results/errors/backoff through
  callbacks. `isWorkCovered` prevents launching work already covered by live
  tasks. `signal` ends backoff waits.
- `createMemoryStoreJanitor` cleans the run's queue/maps and can wait for claims
  to become visible before reclaiming them. Cleanup is best effort.
- `flushMemoryStoreAsync` destroys **all** MemoryStore data in the universe.
  Call it only when the operator explicitly requests a universe-wide flush.
- `publishMessageAsync` publishes a topic message to running tasks. It is the
  transport for cooperative cancellation; the task must subscribe and respond.

Runner and storage options accept injected HTTP clients and sleeps; the runner
also accepts file reading, fetch and capacity-wait adapters. Tests can exercise
transport behavior without credentials or real Roblox tasks.

## Development

Development uses the Node version in `mise.toml` and the pnpm version in the
root `package.json`. Run `mise install` and `pnpm install --frozen-lockfile`,
then run these commands from packages/roblox-runner:

```sh
pnpm build
pnpm lint
pnpm typecheck
pnpm test
pnpm test-unit
pnpm test-type
pnpm integration
pnpm boundaries
pnpm cpd
pnpm knip
pnpm mutation --force
```

`test` runs unit and entry-point type tests with 100% statement, branch,
function and line thresholds over every runtime `.ts` file in `src`. Integration
tests use the package entry points. `knip` includes a production-only pass that
rejects exports used only by specs.

`cpd-production` scans production and test helpers at 40 tokens; `cpd-spec`
scans specs at 75 tokens. Boundaries enforce test-tier isolation, production
cycles, package interfaces and the disk adapter.

The mutation command measures the whole population. `--force` disables
incremental verdict reuse.

Mutation uses unit tests only with a 100% threshold.
