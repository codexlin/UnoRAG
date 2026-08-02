-- Reconcile denormalized library counters after document lifecycle deletes.
-- Older workers refreshed ready_count/status but did not refresh doc_count,
-- so upgraded installations can otherwise keep reporting deleted documents.
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
			WHERE document.status IN ('processing', 'deleting')
		)::integer AS processing_count,
		count(document.id) FILTER (
			WHERE document.status IN ('degraded', 'failed')
		)::integer AS problem_count
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
			WHEN problem_count > 0 THEN 'degraded'
			ELSE 'ready'
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
