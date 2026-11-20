import { createMemoryFileSystem } from "@isentinel/dev-vitest-utils";

import { describe, it } from "vitest";

import { copyIgnoreMatcher } from "#test/helpers/unit/coverage-copy-ignore.ts";
import { posixRoot } from "#test/helpers/unit/posix-root.ts";
import { reconcileShadowToSource, tryRemove } from "./shadow-reconcile.ts";

describe(reconcileShadowToSource, () => {
	it("should remove a shadow file whose source is gone", ({ expect }) => {
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

	it("should keep what a bake owns inside an orphaned directory", ({ expect }) => {
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
	it("should report an entry it cannot delete as kept", ({ expect }) => {
		expect.assertions(1);

		expect(
			tryRemove(() => {
				throw new Error("locked");
			}),
		).toBeFalse();
	});
});
