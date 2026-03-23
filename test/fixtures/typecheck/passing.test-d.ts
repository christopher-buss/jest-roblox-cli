describe("passing types", () => {
	it("should accept number as number", () => {
		const x: number = 1;
		void x;
	});

	it("should accept string as string", () => {
		const y: string = "hello";
		void y;
	});
});
