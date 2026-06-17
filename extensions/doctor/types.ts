export type DoctorStatus = "pass" | "warn" | "fail" | "skip";
export type DoctorCategory = "shell" | "api" | "chrome";

export interface DoctorResult {
	status: DoctorStatus;
	summary: string;
	details?: string[];
	nextSteps?: string[];
}

export interface DoctorCheck {
	id: string;
	title: string;
	category: DoctorCategory;
	run(): Promise<DoctorResult>;
}

export interface DoctorCheckRun {
	check: DoctorCheck;
	result: DoctorResult;
}
