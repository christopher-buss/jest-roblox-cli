import { describe, expect, it } from "vitest";

import { copyIgnoreMatcher } from "#test/mocks/coverage-copy-ignore.ts";
import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { posixRoot } from "#test/mocks/posix-path.ts";
import { reconcileShadowToSource, tryRemove } from "./shadow-reconcile.ts";

describe(reconcileShadowToSource, () => {
	it("should remove a shadow file whose source is gone", () => {
		expect.assertions(3);

		const { fileSystem, volume } = createMemoryFileSystem({
			"/shadow/gone.json": "{}",
			"/shadow/kept.json": "{}",
			"/source/kept.json": "{}",
		});

		const hasDeleted = reconcileShadowToSource({
			fileSystem,
			isBakeOwned: undefined,
			isCopyIgnored: copyIgnoreMatcher([]),
			luauRoot: posixRoot("/source"),
			shadowDir: "/shadow",
		});

		expect(hasDeleted).toBeTrue();
		expect(volume.existsSync("/shadow/gone.json")).toBeFalse();
		expect(volume.existsSync("/shadow/kept.json")).toBeTrue();
	});

	it("should keep what a bake owns inside an orphaned directory", () => {
		expect.assertions(3);

		const { fileSystem, volume } = createMemoryFileSystem({
			"/shadow/orphan/baked/jest.config.luau": "return {}",
			"/shadow/orphan/stale.luau": "return nil",
			"/source/init.luau": "return nil",
		});

		const hasDeleted = reconcileShadowToSource({
			fileSystem,
			isBakeOwned: (shadowPath) => shadowPath.endsWith("jest.config.luau"),
			isCopyIgnored: copyIgnoreMatcher([]),
			luauRoot: posixRoot("/source"),
			shadowDir: "/shadow",
		});

		expect(hasDeleted).toBeTrue();
		expect(volume.existsSync("/shadow/orphan/stale.luau")).toBeFalse();
		expect(volume.existsSync("/shadow/orphan/baked/jest.config.luau")).toBeTrue();
	});
});

describe(tryRemove, () => {
	it("should report an entry it cannot delete as kept", () => {
		expect.assertions(1);

		expect(
			tryRemove(() => {
				throw new Error("locked");
			}),
		).toBeFalse();
	});
});
