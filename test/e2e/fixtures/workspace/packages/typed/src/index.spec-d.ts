describe("typed pass", () => {
	it("should accept a number as number", () => {
		const value: number = 1;
		void value;
	});
});
