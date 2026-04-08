import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import process from "node:process";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import {
	getCacheDirectory,
	getCacheKey,
	isUploaded,
	markUploaded,
	readCache,
	writeCache,
} from "./cache.ts";

describe("cache utilities", () => {
	describe(getCacheKey, () => {
		it("should create key from universe and place only", () => {
			expect.assertions(1);

			const key = getCacheKey("123", "456");

			expect(key).toBe("123:456");
		});
	});

	describe(getCacheDirectory, () => {
		it("should use XDG_CACHE_HOME when set", () => {
			expect.assertions(1);

			vi.stubEnv("XDG_CACHE_HOME", "/custom/cache");
			onTestFinished(() => {
				vi.unstubAllEnvs();
			});

			const directory = getCacheDirectory();

			expect(directory).toBe(path.join("/custom/cache", "jest-roblox"));
		});

		it("should ignore empty XDG_CACHE_HOME", () => {
			expect.assertions(1);

			vi.stubEnv("XDG_CACHE_HOME", "");
			onTestFinished(() => {
				vi.unstubAllEnvs();
			});
			const origPlatform = process.platform;
			Object.defineProperty(process, "platform", { value: "linux" });
			onTestFinished(() => {
				Object.defineProperty(process, "platform", { value: origPlatform });
			});

			const directory = getCacheDirectory();

			expect(directory).toBe(path.join(os.homedir(), ".cache", "jest-roblox"));
		});

		/* cspell:disable-next-line */
		it("should use LOCALAPPDATA on win32", () => {
			expect.assertions(1);

			vi.stubEnv("XDG_CACHE_HOME", "");
			delete process.env["XDG_CACHE_HOME"];
			/* cspell:disable-next-line */
			vi.stubEnv("LOCALAPPDATA", "C:\\Users\\Test\\AppData\\Local");
			onTestFinished(() => {
				vi.unstubAllEnvs();
			});
			const origPlatform = process.platform;
			Object.defineProperty(process, "platform", { value: "win32" });
			onTestFinished(() => {
				Object.defineProperty(process, "platform", { value: origPlatform });
			});

			const directory = getCacheDirectory();

			expect(directory).toBe(path.join("C:\\Users\\Test\\AppData\\Local", "jest-roblox"));
		});

		/* cspell:disable-next-line */
		it("should fall back to tmpdir on win32 when LOCALAPPDATA is empty", () => {
			expect.assertions(1);

			vi.stubEnv("XDG_CACHE_HOME", "");
			delete process.env["XDG_CACHE_HOME"];
			/* cspell:disable-next-line */
			vi.stubEnv("LOCALAPPDATA", "");
			onTestFinished(() => {
				vi.unstubAllEnvs();
			});
			const origPlatform = process.platform;
			Object.defineProperty(process, "platform", { value: "win32" });
			onTestFinished(() => {
				Object.defineProperty(process, "platform", { value: origPlatform });
			});

			const directory = getCacheDirectory();

			expect(directory).toBe(path.join(os.tmpdir(), "jest-roblox"));
		});

		it("should use homedir/.cache on non-win32 without XDG", () => {
			expect.assertions(1);

			vi.stubEnv("XDG_CACHE_HOME", "");
			delete process.env["XDG_CACHE_HOME"];
			onTestFinished(() => {
				vi.unstubAllEnvs();
			});
			const origPlatform = process.platform;
			Object.defineProperty(process, "platform", { value: "linux" });
			onTestFinished(() => {
				Object.defineProperty(process, "platform", { value: origPlatform });
			});

			const directory = getCacheDirectory();

			expect(directory).toBe(path.join(os.homedir(), ".cache", "jest-roblox"));
		});
	});

	describe("cache read/write", () => {
		it("should return empty object when cache file does not exist", () => {
			expect.assertions(1);

			const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "cache-test-"));
			const cacheFile = path.join(temporaryDirectory, "nonexistent.json");
			const cache = readCache(cacheFile);
			fs.rmSync(temporaryDirectory, { force: true, recursive: true });

			expect(cache).toStrictEqual({});
		});

		it("should return empty object for malformed JSON", () => {
			expect.assertions(1);

			const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "cache-test-"));
			const cacheFile = path.join(temporaryDirectory, "bad.json");
			fs.writeFileSync(cacheFile, "not valid json {{{");
			const cache = readCache(cacheFile);
			fs.rmSync(temporaryDirectory, { force: true, recursive: true });

			expect(cache).toStrictEqual({});
		});

		it("should write and read cache", () => {
			expect.assertions(1);

			const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "cache-test-"));
			const cacheFile = path.join(temporaryDirectory, "test-cache.json");
			const cache = { "123:456": { fileHash: "hash", uploadedAt: 1000 } };
			writeCache(cacheFile, cache);
			const read = readCache(cacheFile);
			fs.rmSync(temporaryDirectory, { force: true, recursive: true });

			expect(read).toStrictEqual(cache);
		});

		it("should create directory if it does not exist", () => {
			expect.assertions(1);

			const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "cache-test-"));
			const nestedFile = path.join(temporaryDirectory, "nested", "dir", "cache.json");
			writeCache(nestedFile, { key: { fileHash: "h", uploadedAt: 1 } });
			const exists = fs.existsSync(nestedFile);
			fs.rmSync(temporaryDirectory, { force: true, recursive: true });

			expect(exists).toBe(true);
		});
	});

	describe("isUploaded and markUploaded", () => {
		it("should return false for missing key", () => {
			expect.assertions(1);

			const cache: Record<string, { fileHash: string; uploadedAt: number }> = {};

			expect(isUploaded(cache, "missing", "hash")).toBe(false);
		});

		it("should return true after marking uploaded with same hash", () => {
			expect.assertions(1);

			const cache: Record<string, { fileHash: string; uploadedAt: number }> = {};
			markUploaded(cache, "key", "hash_a");

			expect(isUploaded(cache, "key", "hash_a")).toBe(true);
		});

		it("should return false when hash differs from uploaded hash", () => {
			expect.assertions(1);

			const cache: Record<string, { fileHash: string; uploadedAt: number }> = {};
			markUploaded(cache, "key", "hash_a");

			expect(isUploaded(cache, "key", "hash_b")).toBe(false);
		});

		it("should set uploadedAt timestamp", () => {
			expect.assertions(2);

			const cache: Record<string, { fileHash: string; uploadedAt: number }> = {};
			const before = Date.now();
			markUploaded(cache, "key", "hash_a");
			const after = Date.now();

			expect(cache["key"]!.uploadedAt).toBeGreaterThanOrEqual(before);
			expect(cache["key"]!.uploadedAt).toBeLessThanOrEqual(after);
		});
	});
});
