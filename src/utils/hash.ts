import type buffer from "node:buffer";
import * as crypto from "node:crypto";

export function hashBuffer(data: buffer.Buffer): string {
	return crypto.createHash("sha256").update(data).digest("hex");
}
