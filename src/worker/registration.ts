import {
	type DocumentAclProjectionJob,
	type DocumentDeleteJob,
	type DocumentIngestJob,
	type DurableJobInput,
	type DurableJobKind,
	documentAclProjectionWorkflowInputSchema,
	documentDeleteWorkflowInputSchema,
	documentIngestWorkflowInputSchema,
	type GenerationCleanupJob,
	generationCleanupWorkflowInputSchema,
} from "./contracts";
import { UnknownDurableJobError } from "./errors";
import type { DurableOperationPort, WorkerPorts } from "./ports";
import {
	createDocumentAclProjectionWorkflow,
	createDocumentDeleteWorkflow,
	createDocumentIngestWorkflow,
	createGenerationCleanupWorkflow,
	type DurableWorkflowResult,
} from "./workflows";

export const DBOS_LIFECYCLE_QUEUE = "unorag-lifecycle";

export const durableWorkflowNames = {
	"document.ingest": "unorag.document.ingest.v1",
	"document.acl.project": "unorag.document.acl.project.v1",
	"document.delete": "unorag.document.delete.v1",
	"generation.cleanup": "unorag.generation.cleanup.v1",
} as const satisfies Record<DurableJobKind, string>;

export interface WorkflowRegistrationConfig {
	name: string;
	maxRecoveryAttempts: number;
	inputSchema: {
		parse(input: unknown): unknown;
	};
}

export interface WorkflowRegistrar {
	register<I extends DurableJobInput>(
		workflow: (input: I) => Promise<DurableWorkflowResult>,
		config: WorkflowRegistrationConfig,
	): (input: I) => Promise<DurableWorkflowResult>;
}

export interface RegisteredDurableWorkflows {
	documentIngest: (input: DocumentIngestJob) => Promise<DurableWorkflowResult>;
	documentAclProjection: (
		input: DocumentAclProjectionJob,
	) => Promise<DurableWorkflowResult>;
	documentDelete: (input: DocumentDeleteJob) => Promise<DurableWorkflowResult>;
	generationCleanup: (
		input: GenerationCleanupJob,
	) => Promise<DurableWorkflowResult>;
}

export function registerDurableWorkflows(
	registrar: WorkflowRegistrar,
	ports: WorkerPorts,
	operations: DurableOperationPort,
): RegisteredDurableWorkflows {
	return {
		documentIngest: registrar.register(
			createDocumentIngestWorkflow(ports, operations),
			{
				name: durableWorkflowNames["document.ingest"],
				maxRecoveryAttempts: 10,
				inputSchema: documentIngestWorkflowInputSchema,
			},
		),
		documentAclProjection: registrar.register(
			createDocumentAclProjectionWorkflow(ports, operations),
			{
				name: durableWorkflowNames["document.acl.project"],
				maxRecoveryAttempts: 10,
				inputSchema: documentAclProjectionWorkflowInputSchema,
			},
		),
		documentDelete: registrar.register(
			createDocumentDeleteWorkflow(ports, operations),
			{
				name: durableWorkflowNames["document.delete"],
				maxRecoveryAttempts: 10,
				inputSchema: documentDeleteWorkflowInputSchema,
			},
		),
		generationCleanup: registrar.register(
			createGenerationCleanupWorkflow(ports, operations),
			{
				name: durableWorkflowNames["generation.cleanup"],
				maxRecoveryAttempts: 10,
				inputSchema: generationCleanupWorkflowInputSchema,
			},
		),
	};
}

export function workflowForJob(
	workflows: RegisteredDurableWorkflows,
	input: DurableJobInput,
): (input: never) => Promise<DurableWorkflowResult> {
	switch (input.type) {
		case "document.ingest":
			return workflows.documentIngest as (
				input: never,
			) => Promise<DurableWorkflowResult>;
		case "document.acl.project":
			return workflows.documentAclProjection as (
				input: never,
			) => Promise<DurableWorkflowResult>;
		case "document.delete":
			return workflows.documentDelete as (
				input: never,
			) => Promise<DurableWorkflowResult>;
		case "generation.cleanup":
			return workflows.generationCleanup as (
				input: never,
			) => Promise<DurableWorkflowResult>;
		default:
			throw new UnknownDurableJobError((input as { type?: unknown }).type);
	}
}
