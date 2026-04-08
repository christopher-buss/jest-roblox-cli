import EventEmitter from "node:events";
import type { Mock } from "vitest";
import { vi } from "vitest";

export class MockWebSocket extends EventEmitter {
	public readonly close: Mock<() => void> = vi.fn(() => {
		this.emit("close");
	});
	public readonly send: Mock<(data: string) => void> = vi.fn();
}
