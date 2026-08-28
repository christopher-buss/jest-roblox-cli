import { fromAny } from "@total-typescript/shoehorn";

import { vol } from "memfs";
import * as path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import { createCopyIgnoreMatcher } from "./discover-files.ts";
import type { InstrumentUniverse } from "./instrument-universe.ts";
import { narrowLuauRoots, narrowRootToUniverse } from "./narrow-roots.ts";

vi.mock(import("node:fs"), async () => {
	const memfs = await vi.importActual<typeof import("memfs")>("memfs");
	return fromAny({ ...memfs.fs, default: memfs.fs });
});

const MOUNT = normalizeWindowsPath(path.resolve("/repo/out/server"));

const NO_COPY_IGNORE = createCopyIgnoreMatcher([]);

function resetVolumeAfterTest(): void {
	onTestFinished(() => {
		vol.reset();
	});
}

/** Seeds prod `.luau` files under the mount, keyed by mount-relative path. */
function seed(...relativePaths: Array<string>): void {
	resetVolumeAfterTest();
	vol.fromJSON(Object.fromEntries(relativePaths.map((entry) => [entry, "return nil\n"])), MOUNT);
}

/** A universe that probes exactly the listed mount-relative paths. */
function universeOf(...probed: Array<string>): InstrumentUniverse {
	const absolute = new Set(probed.map((entry) => `${MOUNT}/${entry}`));
	return { digest: "test", includes: (luauPath) => absolute.has(luauPath) };
}

describe(narrowRootToUniverse, () => {
	it("should keep the mount whole when the run narrows nothing", () => {
		expect.assertions(1);

		seed("modules/ecs/world.luau");

		expect(
			narrowRootToUniverse(MOUNT, { isCopyIgnored: NO_COPY_IGNORE, universe: undefined }),
		).toStrictEqual([""]);
	});

	it("should drop a mount the universe never reaches", () => {
		expect.assertions(1);

		seed("modules/ecs/world.luau");

		expect(
			narrowRootToUniverse(MOUNT, {
				isCopyIgnored: NO_COPY_IGNORE,
				universe: universeOf(),
			}),
		).toStrictEqual([]);
	});

	it("should narrow to the directory the probed files live in", () => {
		expect.assertions(1);

		seed(
			"modules/ecs/world.luau",
			"modules/ecs/query.luau",
			"modules/other/a.luau",
			"modules/other/b.luau",
			"client/a.luau",
			"client/b.luau",
		);

		expect(
			narrowRootToUniverse(MOUNT, {
				isCopyIgnored: NO_COPY_IGNORE,
				universe: universeOf("modules/ecs/world.luau", "modules/ecs/query.luau"),
			}),
		).toStrictEqual(["modules/ecs"]);
	});

	it("should collapse a probed directory nested inside another", () => {
		expect.assertions(1);

		seed(
			"modules/ecs/world.luau",
			"modules/ecs/plugins/delta-time/init.luau",
			"client/a.luau",
			"client/b.luau",
			"client/c.luau",
			"client/d.luau",
		);

		// `modules/ecs` mirrors its whole subtree, so keeping the plugin
		// directory as a root of its own would copy and mount it twice.
		expect(
			narrowRootToUniverse(MOUNT, {
				isCopyIgnored: NO_COPY_IGNORE,
				universe: universeOf(
					"modules/ecs/world.luau",
					"modules/ecs/plugins/delta-time/init.luau",
				),
			}),
		).toStrictEqual(["modules/ecs"]);
	});

	it("should keep one root per probed branch", () => {
		expect.assertions(1);

		seed(
			"modules/ecs/world.luau",
			"react/hooks/ecs/use-world.luau",
			"client/a.luau",
			"client/b.luau",
			"client/c.luau",
			"client/d.luau",
		);

		expect(
			narrowRootToUniverse(MOUNT, {
				isCopyIgnored: NO_COPY_IGNORE,
				universe: universeOf("modules/ecs/world.luau", "react/hooks/ecs/use-world.luau"),
			}),
		).toStrictEqual(["modules/ecs", "react/hooks/ecs"]);
	});

	it("should keep the mount whole when a probed file sits directly in it", () => {
		expect.assertions(1);

		// A second probe two directories down, so the answer cannot come from
		// there being only one place to narrow to: the mount holding a probe of
		// its own is what settles it.
		seed(
			"world.luau",
			"modules/ecs/query.luau",
			"client/a.luau",
			"client/b.luau",
			"client/c.luau",
			"client/d.luau",
		);

		expect(
			narrowRootToUniverse(MOUNT, {
				isCopyIgnored: NO_COPY_IGNORE,
				universe: universeOf("world.luau", "modules/ecs/query.luau"),
			}),
		).toStrictEqual([""]);
	});

	it("should keep the mount whole when narrowing would shed almost nothing", () => {
		expect.assertions(1);

		// Ten of eleven files stay, so the roots buy a project node per sibling
		// and almost no copying.
		seed(
			"a/one.luau",
			"a/two.luau",
			"a/three.luau",
			"a/four.luau",
			"a/five.luau",
			"a/six.luau",
			"a/seven.luau",
			"a/eight.luau",
			"a/nine.luau",
			"a/ten.luau",
			"b/eleven.luau",
		);

		expect(
			narrowRootToUniverse(MOUNT, {
				isCopyIgnored: NO_COPY_IGNORE,
				universe: universeOf("a/one.luau"),
			}),
		).toStrictEqual([""]);
	});

	it("should narrow when the retained share lands exactly on the line", () => {
		expect.assertions(1);

		// Nine of ten files stay, which is the share itself rather than more
		// than it, so the roots are worth their nodes.
		seed(
			"a/one.luau",
			"a/two.luau",
			"a/three.luau",
			"a/four.luau",
			"a/five.luau",
			"a/six.luau",
			"a/seven.luau",
			"a/eight.luau",
			"a/nine.luau",
			"b/ten.luau",
		);

		expect(
			narrowRootToUniverse(MOUNT, {
				isCopyIgnored: NO_COPY_IGNORE,
				universe: universeOf("a/one.luau"),
			}),
		).toStrictEqual(["a"]);
	});

	it("should count a file kept by any one root, not by all of them", () => {
		expect.assertions(1);

		// Ten of eleven files stay, split across two roots. Counting only the
		// files every root holds would read as nothing kept, and narrow.
		seed(
			"a/one.luau",
			"a/two.luau",
			"a/three.luau",
			"a/four.luau",
			"a/five.luau",
			"b/six.luau",
			"b/seven.luau",
			"b/eight.luau",
			"b/nine.luau",
			"b/ten.luau",
			"c/eleven.luau",
		);

		expect(
			narrowRootToUniverse(MOUNT, {
				isCopyIgnored: NO_COPY_IGNORE,
				universe: universeOf("a/one.luau", "b/six.luau"),
			}),
		).toStrictEqual([""]);
	});

	it("should judge the share against the files the shadow would carry", () => {
		expect.assertions(1);

		// The copy-ignored siblings never reach the shadow either way, so
		// counting them would make narrowing look like a win when the mount is
		// already down to the one directory that holds a probe.
		seed("a/one.luau", "b/two.luau", "b/three.luau", "b/four.luau");

		expect(
			narrowRootToUniverse(MOUNT, {
				isCopyIgnored: createCopyIgnoreMatcher(["b/**"]),
				universe: universeOf("a/one.luau"),
			}),
		).toStrictEqual([""]);
	});
});

describe(narrowLuauRoots, () => {
	it("should carry a mount through whole when nothing narrows it", () => {
		expect.assertions(1);

		seed("world.luau");

		expect(
			narrowLuauRoots([MOUNT], {
				isCopyIgnored: NO_COPY_IGNORE,
				rojoMounts: new Set([MOUNT]),
				universe: undefined,
			}),
		).toStrictEqual([{ luauRoot: MOUNT, roots: [MOUNT], spine: [] }]);
	});

	it("should name the roots and the way down to them", () => {
		expect.assertions(1);

		seed(
			"modules/ecs/world.luau",
			"client/a.luau",
			"client/b.luau",
			"client/c.luau",
			"client/d.luau",
		);

		expect(
			narrowLuauRoots([MOUNT], {
				isCopyIgnored: NO_COPY_IGNORE,
				rojoMounts: new Set([MOUNT]),
				universe: universeOf("modules/ecs/world.luau"),
			}),
		).toStrictEqual([
			{
				luauRoot: MOUNT,
				roots: [`${MOUNT}/modules/ecs`],
				spine: [MOUNT, `${MOUNT}/modules`],
			},
		]);
	});

	it("should keep a mount the universe never reaches out of the shadow", () => {
		expect.assertions(1);

		seed("client/a.luau");

		expect(
			narrowLuauRoots([MOUNT], {
				isCopyIgnored: NO_COPY_IGNORE,
				rojoMounts: new Set([MOUNT]),
				universe: universeOf(),
			}),
		).toStrictEqual([{ luauRoot: MOUNT, roots: [], spine: [] }]);
	});

	it("should read a mount written with a trailing slash as the same directory", () => {
		expect.assertions(1);

		seed("modules/ecs/world.luau", "client/a.luau", "client/b.luau", "client/c.luau");

		expect(
			narrowLuauRoots([`${MOUNT}/`], {
				isCopyIgnored: NO_COPY_IGNORE,
				rojoMounts: new Set([MOUNT]),
				universe: undefined,
			}),
		).toStrictEqual([{ luauRoot: MOUNT, roots: [MOUNT], spine: [] }]);
	});

	it("should keep the mount whole when the mounts reach past the narrowed roots", () => {
		expect.assertions(1);

		seed(
			"modules/ecs/world.luau",
			"client/a.luau",
			"client/b.luau",
			"client/c.luau",
			"client/d.luau",
		);

		// A mount set that names somewhere else entirely: nothing to redirect,
		// nothing to demote, so the narrowed root would load from source.
		expect(
			narrowLuauRoots([MOUNT], {
				isCopyIgnored: NO_COPY_IGNORE,
				rojoMounts: new Set([`${path.posix.dirname(MOUNT)}/client`]),
				universe: universeOf("modules/ecs/world.luau"),
			}),
		).toStrictEqual([{ luauRoot: MOUNT, roots: [MOUNT], spine: [] }]);
	});

	it("should keep the mount whole when no rojo mount can reach the narrowed roots", () => {
		expect.assertions(1);

		seed(
			"modules/ecs/world.luau",
			"client/a.luau",
			"client/b.luau",
			"client/c.luau",
			"client/d.luau",
		);

		// Nothing to demote means nothing loads the narrowed root, which is
		// coverage that comes back empty with the shadow built for it. A mount
		// set this run could not read is the live way to get here.
		expect(
			narrowLuauRoots([MOUNT], {
				isCopyIgnored: NO_COPY_IGNORE,
				rojoMounts: new Set(),
				universe: universeOf("modules/ecs/world.luau"),
			}),
		).toStrictEqual([{ luauRoot: MOUNT, roots: [MOUNT], spine: [] }]);
	});

	it("should hang the spine off the rojo mount, not the luauRoot above it", () => {
		expect.assertions(1);

		seed(
			"modules/ecs/world.luau",
			"client/a.luau",
			"client/b.luau",
			"client/c.luau",
			"client/d.luau",
		);

		// A luauRoot can sit above the mounts — `luauRoots: ["out"]` against
		// `$path: "out/modules"` — and only a directory the place actually
		// mounts is one a demote can rewrite.
		expect(
			narrowLuauRoots([MOUNT], {
				isCopyIgnored: NO_COPY_IGNORE,
				rojoMounts: new Set([`${MOUNT}/modules`]),
				universe: universeOf("modules/ecs/world.luau"),
			}),
		).toStrictEqual([
			{ luauRoot: MOUNT, roots: [`${MOUNT}/modules/ecs`], spine: [`${MOUNT}/modules`] },
		]);
	});
});
