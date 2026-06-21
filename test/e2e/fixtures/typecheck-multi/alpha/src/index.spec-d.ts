declare function describe(name: string, fn: () => void): void;
declare function it(name: string, fn: () => void): void;

describe("alpha typed pass", () => {
	it("should accept a number assigned to number", () => {
		const value: number = 1;
		void value;
	});
});
