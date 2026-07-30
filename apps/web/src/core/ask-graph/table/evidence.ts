import type { TableEvidence } from "./contracts";
import {
	type NormalizedTableRow,
	type TableSourceRecord,
	tableSourceId,
} from "./normalize";

const MAX_EVIDENCE_ROWS = 200;

interface EvidenceBuildResult {
	evidence: TableEvidence[];
	truncated: boolean;
}

function sourcePage(
	source: TableSourceRecord,
	key: "page_start" | "page_end",
): number | null {
	return source[key] ?? null;
}

export function buildTableEvidence(
	rows: readonly NormalizedTableRow[],
): EvidenceBuildResult {
	const limited = rows.slice(0, MAX_EVIDENCE_ROWS);
	const grouped = new Map<
		string,
		{ source: TableSourceRecord; rows: NormalizedTableRow[] }
	>();
	for (const row of limited) {
		const key = tableSourceId(row.source);
		const group = grouped.get(key) ?? { source: row.source, rows: [] };
		group.rows.push(row);
		grouped.set(key, group);
	}
	const evidence = [...grouped.values()].map(({ source, rows: groupRows }) => {
		const indices = groupRows.map((row) => row.absoluteIndex);
		return {
			citationId: tableSourceId(source),
			tableId: source.table_id ?? "unknown-table",
			docId: source.doc_id,
			documentVersionId: source.document_version_id,
			pageStart: sourcePage(source, "page_start"),
			pageEnd: sourcePage(source, "page_end"),
			rowStart: Math.min(...indices),
			rowEnd: Math.max(...indices),
			rowIndices: indices,
			headers: [...(source.headers ?? [])],
			rows: groupRows.map((row) => [...row.raw]),
		};
	});
	return { evidence, truncated: rows.length > limited.length };
}
