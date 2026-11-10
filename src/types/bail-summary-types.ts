/** Packages a bailed run reached, and packages it never started. */
export interface BailSummary {
	/** Packages the run never started. */
	notRun: number;
	/** Packages the run started, the failing one included. */
	ran: number;
}
