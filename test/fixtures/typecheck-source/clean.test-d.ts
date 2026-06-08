describe("clean types", () => {
	it("should accept number as number", () => {
		const value: number = 1;
		void value;
	});
});
