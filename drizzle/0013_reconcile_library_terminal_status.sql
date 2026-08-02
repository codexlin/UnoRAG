-- Reconcile summaries left stale when lifecycle jobs reached a terminal state.
-- A library with only failed documents is failed, while active content plus
-- failures remains degraded and available for retrieval.
WITH counts AS (
	SELECT
		library.id,
		library.status,
		count(document.id) FILTER (
			WHERE document.status NOT IN ('deleting', 'deleted')
		)::integer AS document_count,
		count(document.id) FILTER (
			WHERE document.status IN ('ready', 'degraded')
		)::integer AS ready_count,
		count(document.id) FILTER (
			WHERE document.status = 'processing'
		)::integer AS processing_count,
		count(document.id) FILTER (
			WHERE document.status = 'failed'
		)::integer AS failed_count
	FROM app.libraries AS library
	LEFT JOIN app.documents AS document
		ON document.library_id = library.id
	GROUP BY library.id, library.status
),
desired AS (
	SELECT
		id,
		document_count,
		ready_count,
		CASE
			WHEN status = 'deleted' THEN 'deleted'
			WHEN status = 'deleting' THEN 'deleting'
			WHEN document_count = 0 THEN 'empty'
			WHEN processing_count > 0 THEN 'indexing'
			WHEN ready_count = document_count THEN 'ready'
			WHEN ready_count > 0 THEN 'degraded'
			WHEN failed_count > 0 THEN 'failed'
			ELSE 'empty'
		END AS status
	FROM counts
)
UPDATE app.libraries AS library
SET
	doc_count = desired.document_count,
	ready_count = desired.ready_count,
	status = desired.status,
	updated_at = now()
FROM desired
WHERE library.id = desired.id
	AND (
		library.doc_count IS DISTINCT FROM desired.document_count
		OR library.ready_count IS DISTINCT FROM desired.ready_count
		OR library.status IS DISTINCT FROM desired.status
	);
