import { fromAny } from "@total-typescript/shoehorn";

import { vol } from "memfs";
import * as cp from "node:child_process";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { getAffectedPackages } from "./affected.ts";

vi.mock(import("node:fs"), async () => {
	const memfs = await vi.importActual<typeof import("memfs")>("memfs");
	return fromAny({ ...memfs.fs, default: memfs.fs });
});

vi.mock(import("node:child_process"));

const ROOT = path.resolve("/repo");

describe(getAffectedPackages, () => {
	it("should shell out to turbo when turbo.json is present and parse the package list", () => {
		expect.assertions(2);

		vol.reset();
		vol.fromJSON({ [path.join(ROOT, "turbo.json")]: "{}" });

		vi.mocked(cp.execFileSync).mockReturnValue(
			JSON.stringify({
				packages: {
					items: [{ name: "@org/foo" }, { name: "@org/bar" }],
				},
			}),
		);

		expect(getAffectedPackages(ROOT, "main")).toStrictEqual(["@org/foo", "@org/bar"]);
		expect(vi.mocked(cp.execFileSync)).toHaveBeenCalledWith(
			"turbo",
			["ls", "--affected", "--filter=...[main]", "--output=json"],
			expect.objectContaining({ cwd: ROOT }),
		);
	});

	it("should throw with a descriptive error when turbo output does not match the expected schema", () => {
		expect.assertions(1);

		vol.reset();
		vol.fromJSON({ [path.join(ROOT, "turbo.json")]: "{}" });
		vi.mocked(cp.execFileSync).mockReturnValue(JSON.stringify({ unexpected: true }));

		expect(() => getAffectedPackages(ROOT, "main")).toThrow(/Unexpected turbo ls output/);
	});

	it("should throw with a descriptive error when turbo output is not valid JSON", () => {
		expect.assertions(1);

		vol.reset();
		vol.fromJSON({ [path.join(ROOT, "turbo.json")]: "{}" });
		vi.mocked(cp.execFileSync).mockReturnValue("warn: cache miss\nnot-json-at-all");

		expect(() => getAffectedPackages(ROOT, "main")).toThrow(/turbo returned non-JSON output/);
	});

	it("should throw with a descriptive error when nx output does not match the expected schema", () => {
		expect.assertions(1);

		vol.reset();
		vol.fromJSON({ [path.join(ROOT, "nx.json")]: "{}" });
		vi.mocked(cp.execFileSync).mockReturnValue(JSON.stringify({ unexpected: true }));

		expect(() => getAffectedPackages(ROOT, "main")).toThrow(
			/Unexpected nx show projects output/,
		);
	});

	it("should throw with a descriptive error when nx output is not valid JSON", () => {
		expect.assertions(1);

		vol.reset();
		vol.fromJSON({ [path.join(ROOT, "nx.json")]: "{}" });
		vi.mocked(cp.execFileSync).mockReturnValue("not-json");

		expect(() => getAffectedPackages(ROOT, "main")).toThrow(/nx returned non-JSON output/);
	});

	it("should reject extra keys in the turbo schema", () => {
		expect.assertions(1);

		vol.reset();
		vol.fromJSON({ [path.join(ROOT, "turbo.json")]: "{}" });
		vi.mocked(cp.execFileSync).mockReturnValue(
			JSON.stringify({
				extraKey: "future-field",
				packages: { items: [{ name: "@org/foo" }] },
			}),
		);

		expect(() => getAffectedPackages(ROOT, "main")).toThrow(/Unexpected turbo ls output/);
	});

	it("should throw a friendly error when turbo is not on PATH", () => {
		expect.assertions(1);

		vol.reset();
		vol.fromJSON({ [path.join(ROOT, "turbo.json")]: "{}" });
		const enoent = Object.assign(new Error("spawn turbo ENOENT"), { code: "ENOENT" });
		vi.mocked(cp.execFileSync).mockImplementation(() => {
			throw enoent;
		});

		expect(() => getAffectedPackages(ROOT, "main")).toThrow(/turbo was not found on PATH/);
	});

	it("should include stderr content in the error when turbo exits non-zero", () => {
		expect.assertions(1);

		vol.reset();
		vol.fromJSON({ [path.join(ROOT, "turbo.json")]: "{}" });
		const stderrError = Object.assign(new Error("turbo exited with code 1"), {
			stderr: "invalid filter syntax",
		});
		vi.mocked(cp.execFileSync).mockImplementation(() => {
			throw stderrError;
		});

		expect(() => getAffectedPackages(ROOT, "main")).toThrow(
			/turbo failed: invalid filter syntax/,
		);
	});

	it("should fall back to a generic failure message when turbo stderr is not a string", () => {
		expect.assertions(1);

		vol.reset();
		vol.fromJSON({ [path.join(ROOT, "turbo.json")]: "{}" });
		const numericStderr = Object.assign(new Error("turbo exited with code 1"), {
			stderr: 12_345,
		});
		vi.mocked(cp.execFileSync).mockImplementation(() => {
			throw numericStderr;
		});

		expect(() => getAffectedPackages(ROOT, "main")).toThrowWithMessage(Error, "turbo failed");
	});

	it("should fall back to a generic failure message when turbo error has no stderr", () => {
		expect.assertions(2);

		vol.reset();
		vol.fromJSON({ [path.join(ROOT, "turbo.json")]: "{}" });
		const bareError = new Error("turbo exited with code 1");
		vi.mocked(cp.execFileSync).mockImplementation(() => {
			throw bareError;
		});

		function act(): unknown {
			return getAffectedPackages(ROOT, "main");
		}

		expect(act).toThrowWithMessage(Error, "turbo failed");
		expect(act).toThrow(expect.objectContaining({ cause: bareError }) as Error);
	});

	it("should throw a clear error directing users to --packages when neither tool is detected", () => {
		expect.assertions(1);

		vol.reset();
		vol.fromJSON({ [path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n" });

		expect(() => getAffectedPackages(ROOT, "main")).toThrow(
			/--affected-since requires turbo or nx.*--packages/s,
		);
	});

	it("should shell out to nx when nx.json is present and parse the project list", () => {
		expect.assertions(2);

		vol.reset();
		vol.fromJSON({ [path.join(ROOT, "nx.json")]: "{}" });

		vi.mocked(cp.execFileSync).mockReturnValue(JSON.stringify(["proj-a", "proj-b"]));

		expect(getAffectedPackages(ROOT, "develop")).toStrictEqual(["proj-a", "proj-b"]);
		expect(vi.mocked(cp.execFileSync)).toHaveBeenCalledWith(
			"nx",
			["show", "projects", "--affected", "--base=develop", "--json"],
			expect.objectContaining({ cwd: ROOT }),
		);
	});
});
