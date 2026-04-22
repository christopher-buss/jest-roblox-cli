export function greet(name: string): string {
	// Keep this return on line 2; source-mapping e2e asserts it.
	return `hello ${name}`;
}

export function add(a: number, b: number): number {
	return a + b;
}
