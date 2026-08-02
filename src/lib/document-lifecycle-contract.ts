import contract from "../../contracts/document-lifecycle-v1.json";

export const DOCUMENT_LIFECYCLE_CONTRACT_VERSION = contract.version;
export const DOCUMENT_STATUSES = contract.document_statuses;
export const DOCUMENT_VERSION_STATUSES = contract.version_statuses;
export const JOB_STATUSES = contract.job_statuses;
export const JOB_STAGES = contract.job_stages;
export const TERMINAL_JOB_STATUSES = new Set(contract.terminal_job_statuses);
export const RETRYABLE_JOB_STATUSES = new Set(contract.retryable_job_statuses);
export const JOB_DEFAULTS = contract.defaults;

export type JobStatus = (typeof contract.job_statuses)[number];
export type JobStage = (typeof contract.job_stages)[number];
