export function add(a: number, b: number): number {
	return a + b;
}

export function subtract(a: number, b: number): number {
	return a - b;
}

// One branch per `it.each` row in example.spec.ts: attribution records a test
// only when it covers a statement no earlier test reached, so each row needs
// a statement of its own.
export function sign(n: number): "negative" | "positive" | "zero" {
	if (n < 0) {
		return "negative";
	}

	if (n > 0) {
		return "positive";
	}

	return "zero";
}
