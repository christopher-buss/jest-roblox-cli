import { describe, expect, it } from "vitest";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { SANDBOX_PREFIX, sweepStaleSandboxes } from "./sandbox-sweep.ts";

const ROOT = "/sandboxes";
const NOW = Date.UTC(2026, 0, 2);
const ONE_DAY_AGO = new Date(NOW - 24 * 60 * 60 * 1000);
const ONE_MINUTE_AGO = new Date(NOW - 60 * 1000);

function seedSandbox(name: string, modified: Date) {
	const memory = createMemoryFileSystem(
		{ [`${ROOT}/${name}/rbxts-project/src/a.spec.ts`]: "" },
		"/",
	);
	memory.volume.utimesSync(`${ROOT}/${name}`, modified, modified);
	return memory;
}

describe(sweepStaleSandboxes, () => {
	it("should delete a sandbox an interrupted run left behind", () => {
		expect.assertions(1);

		const leaked = `${SANDBOX_PREFIX}Ab3xYz`;
		const { fileSystem } = seedSandbox(leaked, ONE_DAY_AGO);

		sweepStaleSandboxes({ fileSystem, now: NOW, root: ROOT });

		expect(fileSystem.existsSync(`${ROOT}/${leaked}`)).toBeFalse();
	});

	// The root sits in the repo so a sandbox can be read after the test that
	// built it failed. Renaming one out of the `mkdtemp` prefix is how you keep
	// it past the next run, so the sweep matches on that prefix rather than
	// emptying the directory.
	it("should leave a renamed sandbox kept for inspection alone", () => {
		expect.assertions(1);

		const { fileSystem } = seedSandbox("keep-the-failing-one", ONE_DAY_AGO);

		sweepStaleSandboxes({ fileSystem, now: NOW, root: ROOT });

		expect(fileSystem.existsSync(`${ROOT}/keep-the-failing-one`)).toBeTrue();
	});

	// The root is shared: the `live` and `integration` projects build sandboxes
	// in it too, and CI runs `nx affected --parallel=2 -t e2e e2e-live`. A sweep
	// that deleted whatever it found would take a concurrent run's live sandbox
	// with it, mid-test.
	it("should leave a sandbox young enough to belong to a running suite", () => {
		expect.assertions(1);

		const inFlight = `${SANDBOX_PREFIX}Cd4wXy`;
		const { fileSystem } = seedSandbox(inFlight, ONE_MINUTE_AGO);

		sweepStaleSandboxes({ fileSystem, now: NOW, root: ROOT });

		expect(fileSystem.existsSync(`${ROOT}/${inFlight}`)).toBeTrue();
	});

	// The same concurrency, one step finer: a live run's `onTestFinished` can
	// take its sandbox away between the listing and the measurement. A dangling
	// link is that gap made reproducible: the name is listed, and reading it
	// raises ENOENT. Throwing here would fail the whole run from `globalSetup`,
	// which is the outcome the age gate exists to avoid.
	it("should skip an entry that disappears before it is measured", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem({ [`${ROOT}/.keep`]: "" }, "/");
		volume.symlinkSync(`${ROOT}/already-deleted`, `${ROOT}/${SANDBOX_PREFIX}Ef5zAb`);

		expect(() => {
			sweepStaleSandboxes({ fileSystem, now: NOW, root: ROOT });
		}).not.toThrow();
	});

	it("should do nothing when no run has made the root yet", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({}, "/");

		expect(() => {
			sweepStaleSandboxes({ fileSystem, now: NOW, root: ROOT });
		}).not.toThrow();
	});
});
