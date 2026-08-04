import { z } from "zod";

const MetadataSchema = z.record(z.string(), z.unknown());
const NullablePageSchema = z.number().int().positive().nullable().default(null);

export const NodeTypeSchema = z.enum([
	"heading",
	"paragraph",
	"list",
	"table",
	"code",
	"figure",
	"footnote",
	"slide",
	"page",
]);

export type NodeType = z.infer<typeof NodeTypeSchema>;

export const SplitStrategySchema = z.enum([
	"heading",
	"table",
	"code",
	"figure",
	"page",
	"recursive",
	"semantic",
	"char_window",
]);

export type SplitStrategy = z.infer<typeof SplitStrategySchema>;

export const ParserReportSchema = z
	.object({
		source_format: z.string().default(""),
		parser: z.string().default(""),
		backend: z.string().default(""),
		parser_version: z.string().default(""),
		mode: z.string().default(""),
		latency_ms: z.number().nonnegative().nullable().default(null),
		text_pages: z.array(z.number().int().positive()).default([]),
		ocr_pages: z.array(z.number().int().positive()).default([]),
		vlm_pages: z.array(z.number().int().positive()).default([]),
		failed_pages: z.array(z.number().int().positive()).default([]),
		needs_ocr_pages: z.array(z.number().int().positive()).default([]),
		vlm_pending_pages: z.array(z.number().int().positive()).default([]),
		warnings: z.array(z.string()).default([]),
		partial: z.boolean().default(false),
		notes: z.string().default(""),
		metrics: MetadataSchema.default({}),
	})
	.strict();

export type ParserReport = z.infer<typeof ParserReportSchema>;

export const TableDataTypeSchema = z.enum([
	"string",
	"integer",
	"number",
	"currency",
	"percentage",
	"date",
	"boolean",
]);

export type TableDataType = z.infer<typeof TableDataTypeSchema>;

export const TableCellSchema = z
	.object({
		raw_text: z.string().default(""),
		normalized_value: z
			.union([z.string(), z.number(), z.boolean()])
			.nullable()
			.default(null),
		page: NullablePageSchema,
		bbox: z.array(z.number()).nullable().default(null),
		confidence: z.number().min(0).max(1).nullable().default(null),
		rowspan: z.number().int().positive().default(1),
		colspan: z.number().int().positive().default(1),
	})
	.strict();

export type TableCell = z.infer<typeof TableCellSchema>;

export const TableColumnSchema = z
	.object({
		name: z.string(),
		normalized_name: z.string(),
		data_type: TableDataTypeSchema.default("string"),
		unit: z.string().nullable().default(null),
	})
	.strict();

export type TableColumn = z.infer<typeof TableColumnSchema>;

export const TableRowSchema = z
	.object({
		cells: z.array(TableCellSchema).default([]),
	})
	.strict();

export type TableRow = z.infer<typeof TableRowSchema>;

export const TableSummaryRowSchema = z
	.object({
		raw_text: z.string(),
		cells: z.array(TableCellSchema).default([]),
		page: NullablePageSchema,
	})
	.strict();

export type TableSummaryRow = z.infer<typeof TableSummaryRowSchema>;

export const TableQualityReportSchema = z
	.object({
		score: z.number().min(0).max(1).default(1),
		executable: z.boolean().default(true),
		header_inferred: z.boolean().default(false),
		header_confidence: z.number().min(0).max(1).nullable().default(null),
		expected_columns: z.number().int().nonnegative().default(0),
		irregular_row_count: z.number().int().nonnegative().default(0),
		low_confidence_cell_count: z.number().int().nonnegative().default(0),
		cross_page_merged: z.boolean().default(false),
		warnings: z.array(z.string()).default([]),
	})
	.strict();

export type TableQualityReport = z.infer<typeof TableQualityReportSchema>;

export const TableIRSchema = z
	.object({
		version: z.literal("v2").default("v2"),
		table_id: z.string().min(1),
		page_start: NullablePageSchema,
		page_end: NullablePageSchema,
		caption: z.string().default(""),
		header_rows: z.array(z.array(z.string())).default([]),
		columns: z.array(TableColumnSchema).default([]),
		rows: z.array(TableRowSchema).default([]),
		summary_rows: z.array(TableSummaryRowSchema).default([]),
		footnotes: z.array(z.string()).default([]),
		quality_report: TableQualityReportSchema.default(() =>
			TableQualityReportSchema.parse({}),
		),
	})
	.strict();

export type TableIR = z.infer<typeof TableIRSchema>;

export const NodeSchema = z
	.object({
		id: z.string().min(1),
		type: NodeTypeSchema,
		path: z.string().nullable().default(null),
		level: z.number().int().positive().nullable().default(null),
		page_start: NullablePageSchema,
		page_end: NullablePageSchema,
		text: z.string().default(""),
		table_json: z
			.union([MetadataSchema, z.array(z.unknown())])
			.nullable()
			.default(null),
		table_ir: TableIRSchema.nullable().default(null),
		figure_desc: z.string().nullable().default(null),
		confidence: z.number().min(0).max(1).nullable().default(null),
		table_id: z.string().nullable().default(null),
		figure_id: z.string().nullable().default(null),
		meta: MetadataSchema.default({}),
	})
	.strict();

export type DocumentNode = z.infer<typeof NodeSchema>;

export const ChunkSchema = z
	.object({
		chunk_index: z.number().int().nonnegative(),
		text: z.string(),
		body: z.string(),
		preamble: z.string().default(""),
		section_path: z.string().nullable().default(null),
		heading_text: z.string().nullable().default(null),
		page_start: NullablePageSchema,
		page_end: NullablePageSchema,
		page_label: z.string().nullable().default(null),
		node_ids: z.array(z.string()).default([]),
		table_id: z.string().nullable().default(null),
		figure_id: z.string().nullable().default(null),
		split_strategy: SplitStrategySchema.default("heading"),
		source_format: z.string().default(""),
		content_hash: z.string().default(""),
		meta: MetadataSchema.default({}),
	})
	.strict();

export type Chunk = z.infer<typeof ChunkSchema>;

export const DocumentIRSchema = z
	.object({
		id: z.string().min(1),
		library_id: z.string().default(""),
		source: z.string().default(""),
		source_format: z.string().default(""),
		title: z.string().default(""),
		filename: z.string().default(""),
		content_hash: z.string().default(""),
		version: z.number().int().positive().default(1),
		nodes: z.array(NodeSchema).default([]),
		parser_report: ParserReportSchema.default(() =>
			ParserReportSchema.parse({}),
		),
		meta: MetadataSchema.default({}),
	})
	.strict();

export type DocumentIR = z.infer<typeof DocumentIRSchema>;
