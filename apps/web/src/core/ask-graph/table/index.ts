export type { TableEvidence, TableExecutionResult } from "./contracts";
export {
	CompareTableQueryPlanSchema,
	JoinTableQueryPlanSchema,
	SingleTableQueryPlanSchema,
	TableComparisonOperatorSchema,
	TableEvidenceSchema,
	TableExecutionResultSchema,
	TablePredicateSchema,
	type TableQueryPlan,
	TableQueryPlanSchema,
} from "./contracts";
export { executeTableQuery } from "./execute";
export {
	type NormalizedTable,
	type NormalizedTableRow,
	normalizeTable,
	parseTableNumber,
	resolveColumn,
	type TableDatasetInput,
	type TableSourceRecord,
} from "./normalize";
