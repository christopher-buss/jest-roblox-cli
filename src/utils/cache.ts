import * as fs from "node:fs";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import process from "node:process";

const CACHE_DIR_NAME = "jest-roblox";

type UploadCache = Record<string, { fileHash: string; uploadedAt: number }>;

export function getCacheDirectory(): string {
	const xdgCacheHome = process.env["XDG_CACHE_HOME"];
	if (xdgCacheHome !== undefined && xdgCacheHome !== "") {
		return path.join(xdgCacheHome, CACHE_DIR_NAME);
	}

	if (process.platform === "win32") {
		const localAppData = process.env["LOCALAPPDATA"];
		if (localAppData !== undefined && localAppData !== "") {
			return path.join(localAppData, CACHE_DIR_NAME);
		}

		return path.join(tmpdir(), CACHE_DIR_NAME);
	}

	return path.join(homedir(), ".cache", CACHE_DIR_NAME);
}

export function getCacheKey(universeId: string, placeId: string): string {
	return `${universeId}:${placeId}`;
}

export function isUploaded(cache: UploadCache, key: string, fileHash: string): boolean {
	return cache[key]?.fileHash === fileHash;
}

export function markUploaded(cache: UploadCache, key: string, fileHash: string): void {
	cache[key] = { fileHash, uploadedAt: Date.now() };
}

export function readCache(cacheFilePath: string): UploadCache {
	try {
		const data = fs.readFileSync(cacheFilePath, "utf-8");
		return JSON.parse(data) as UploadCache;
	} catch {
		return {};
	}
}

export function writeCache(cacheFilePath: string, cache: UploadCache): void {
	const cacheDirectory = path.dirname(cacheFilePath);
	fs.mkdirSync(cacheDirectory, { recursive: true });
	fs.writeFileSync(cacheFilePath, JSON.stringify(cache, null, 2));
}
