/**
 * Helpers for a spec standing a fake in for a real Roblox task. Kept off the
 * package root so nothing here is part of the runtime surface: a fake that
 * speaks a wire format this package owns must not oblige the package to keep
 * the format's spelling public.
 */

export { formatPlaceVersionRefusal, PLACE_VERSION_MISMATCH } from "./place-version-guard.ts";
