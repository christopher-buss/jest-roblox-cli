import type { StorageClient } from "@bedrock-rbx/ocale/storage";

import { type } from "arktype";

import { listSortedMapItemsAsync, resolveStorageClient } from "./sorted-map-page.ts";

const testProgressSchema = type({
	elapsedMs: "number",
	state: "'completed' | 'started'",
	testFilePath: "string",
	testName: "string",
});

/**
 * The last thing one Open Cloud task said it was doing.
 *
 * Written by the runtime on a per-task key it overwrites, so the map holds one
 * record per task rather than one per test — the host only ever asks which test
 * a wedged task had reached, and a per-test key would answer that by making the
 * reader sort a whole run's worth of history.
 */
export interface TestProgressEntry {
	/**
	 * Milliseconds into the Jest run that wrote it. One run per task in multi
	 * mode; one per package in workspace mode, which is why this is read as
	 * "how far into the thing that hung" rather than as a task clock.
	 */
	elapsedMs: number;
	/**
	 * Whether the named test had finished by the time the record was written.
	 */
	state: "completed" | "started";
	/** DataModel path of the test file the run had reached. */
	testFilePath: string;
	/**
	 * Jest's full name for the test, empty when the file had yet to start one.
	 */
	testName: string;
}

/**
 * Minimal surface the wedge report reads through, so a test can stand one in
 * without the SDK class hierarchy.
 */
export interface TestProgressReader {
	readAllAsync(): Promise<Array<TestProgressEntry>>;
}

export interface TestProgressClientOptions {
	/** Override the Open Cloud base URL (default: live Roblox endpoint). */
	baseUrl?: string | undefined;
	credentials: { apiKey: string; universeId: string };
	/** Per-run UUID-keyed sorted-map identifier shared with the runtime. */
	mapId: string;
	/** Override the StorageClient factory (default: real client). Test seam. */
	storageFactory?: () => StorageClient;
}

/**
 * Reads the per-task progress map the Roblox runtime heartbeats into.
 *
 * Read-only on this side: nothing on the host writes progress, and the records
 * expire with the map's TTL rather than being consumed, because the one caller
 * reads them exactly once — after a run has already failed.
 */
export class TestProgressClient implements TestProgressReader {
	private readonly mapId: string;
	private readonly storage: StorageClient;
	private readonly universeId: string;

	constructor(options: TestProgressClientOptions) {
		this.mapId = options.mapId;
		this.universeId = options.credentials.universeId;
		this.storage = resolveStorageClient(options);
	}

	public async readAllAsync(): Promise<Array<TestProgressEntry>> {
		return listSortedMapItemsAsync({
			decode: (item) => decodeTestProgress(item.value),
			failureLabel: "test progress",
			mapId: this.mapId,
			storage: this.storage,
			universeId: this.universeId,
		});
	}
}

/**
 * Validates a wire payload against {@link TestProgressEntry}; throws on
 * mismatch.
 */
export function decodeTestProgress(value: JSONValue): TestProgressEntry {
	return testProgressSchema.assert(value);
}
