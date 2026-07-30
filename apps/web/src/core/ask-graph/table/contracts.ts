import { z } from "zod";

const ColumnNameSchema = z.string().trim().min(1).max(160);
const ScalarSchema = z.union([
	z.string().trim().min(1).max(256),
	z.number().finite(),
	z.boolean(),
]);

export const TableComparisonOperatorSchema = z.enum([
	"==",
	"!=",
	">",
	">=",
	"<",
	"<=",
	"contains",
	"超过",
	"大于",
	"大于等于",
	"不少于",
	"不低于",
	"小于",
	"小于等于",
	"不高于",
	"不多于",
]);

export type TableComparisonOperator = z.infer<
	typeof TableComparisonOperatorSchema
>;

export const TablePredicateSchema = z
	.object({
		column: ColumnNameSchema,
		operator: TableComparisonOperatorSchema,
		value: ScalarSchema,
	})
	.strict();

const CommonSingleFields = {
	mode: z.literal("single"),
	selectColumns: z.array(ColumnNameSchema).max(32).default([]),
	where: TablePredicateSchema.optional(),
	includeSummaryRows: z.boolean().default(false),
} as const;

const LookupPlanSchema = z
	.object({
		...CommonSingleFields,
		operation: z.literal("lookup"),
		entity: z
			.object({
				column: ColumnNameSchema,
				value: ScalarSchema,
				match: z.enum(["exact", "contains"]).default("exact"),
			})
			.strict(),
	})
	.strict();

const FilterPlanSchema = z
	.object({
		...CommonSingleFields,
		operation: z.literal("filter"),
		where: TablePredicateSchema,
	})
	.strict();

const SortPlanSchema = z
	.object({
		...CommonSingleFields,
		operation: z.literal("sort"),
		column: ColumnNameSchema,
		direction: z.enum(["asc", "desc"]).default("asc"),
		limit: z.number().int().positive().max(200).optional(),
	})
	.strict();

const TopNPlanSchema = z
	.object({
		...CommonSingleFields,
		operation: z.literal("topN"),
		column: ColumnNameSchema,
		direction: z.enum(["asc", "desc"]).default("desc"),
		limit: z.number().int().positive().max(200),
	})
	.strict();

const CountPlanSchema = z
	.object({
		...CommonSingleFields,
		operation: z.literal("count"),
	})
	.strict();

const AggregatePlanSchema = z
	.object({
		...CommonSingleFields,
		operation: z.enum(["sum", "avg", "min", "max"]),
		column: ColumnNameSchema,
	})
	.strict();

export const SingleTableQueryPlanSchema = z.discriminatedUnion("operation", [
	LookupPlanSchema,
	FilterPlanSchema,
	SortPlanSchema,
	TopNPlanSchema,
	CountPlanSchema,
	AggregatePlanSchema,
]);

const JoinKeySchema = z
	.object({
		leftColumn: ColumnNameSchema,
		rightColumn: ColumnNameSchema,
	})
	.strict();

export const JoinTableQueryPlanSchema = z
	.object({
		mode: z.literal("dual"),
		operation: z.literal("join"),
		join: JoinKeySchema,
		entity: z
			.object({
				column: ColumnNameSchema,
				value: ScalarSchema,
				match: z.enum(["exact", "contains"]).default("exact"),
			})
			.strict()
			.optional(),
		selectColumns: z.array(ColumnNameSchema).min(1).max(32),
		limit: z.number().int().positive().max(200).default(50),
	})
	.strict();

export const CompareTableQueryPlanSchema = z
	.object({
		mode: z.literal("dual"),
		operation: z.literal("compare"),
		join: JoinKeySchema,
		leftValueColumn: ColumnNameSchema,
		rightValueColumn: ColumnNameSchema,
		comparison: z
			.enum(["difference", "ratio", "equal", "greater", "less"])
			.default("difference"),
		entity: z
			.object({
				column: ColumnNameSchema,
				value: ScalarSchema,
				match: z.enum(["exact", "contains"]).default("exact"),
			})
			.strict()
			.optional(),
		selectColumns: z.array(ColumnNameSchema).max(32).default([]),
		limit: z.number().int().positive().max(200).default(50),
	})
	.strict();

export const TableQueryPlanSchema = z.union([
	SingleTableQueryPlanSchema,
	JoinTableQueryPlanSchema,
	CompareTableQueryPlanSchema,
]);

export type TableQueryPlan = z.infer<typeof TableQueryPlanSchema>;

export const TableEvidenceSchema = z
	.object({
		citationId: z.string().min(1),
		tableId: z.string().min(1),
		docId: z.string().min(1),
		documentVersionId: z.string().min(1),
		pageStart: z.number().int().nullable(),
		pageEnd: z.number().int().nullable(),
		rowStart: z.number().int().nonnegative(),
		rowEnd: z.number().int().nonnegative(),
		rowIndices: z.array(z.number().int().nonnegative()),
		headers: z.array(z.string()),
		rows: z.array(z.array(z.string())),
	})
	.strict();

export type TableEvidence = z.infer<typeof TableEvidenceSchema>;

export const TableExecutionResultSchema = z
	.object({
		status: z.enum(["success", "clarify", "refuse"]),
		operation: z.string().min(1),
		reason: z.string().min(1),
		answerValue: z.unknown().nullable(),
		answerText: z.string().nullable(),
		matchedCount: z.number().int().nonnegative(),
		matchedRows: z.array(z.record(z.string(), z.unknown())),
		matchedRowsTruncated: z.boolean(),
		evidence: z.array(TableEvidenceSchema),
		evidenceTruncated: z.boolean(),
	})
	.strict();

export type TableExecutionResult = z.infer<typeof TableExecutionResultSchema>;
