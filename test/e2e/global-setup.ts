import { sweepStaleSandboxes } from "./sandbox-root.ts";

// Vitest `globalSetup` for the `e2e` project. Runs once, before any spec file
// starts, which is the only point in a run where nothing this project owns is
// in flight.
export default function globalSetup(): void {
	sweepStaleSandboxes();
}
