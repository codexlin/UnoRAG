#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck disable=SC1091
source "${ROOT}/scripts/compose-env.sh"

port="$(mk_config_get GRAFANA_PORT || echo 3300)"
user="$(mk_config_get GRAFANA_ADMIN_USER || echo admin)"
password="$(mk_config_get GRAFANA_ADMIN_PASSWORD || true)"
[[ -n "$password" ]] || { echo "missing GRAFANA_ADMIN_PASSWORD" >&2; exit 1; }

base="http://127.0.0.1:${port}"
for attempt in $(seq 1 30); do
	if curl -fsS -u "${user}:${password}" "${base}/api/health" >/dev/null; then
		break
	fi
	[[ "$attempt" -lt 30 ]] || { echo "Grafana did not become ready" >&2; exit 1; }
	sleep 2
done

for uid in prometheus loki; do
	curl -fsS -u "${user}:${password}" \
		"${base}/api/datasources/uid/${uid}/health" >/dev/null || {
		echo "Grafana datasource ${uid} is not healthy" >&2
		exit 1
	}
done

curl -fsS -u "${user}:${password}" \
	"${base}/api/datasources/proxy/uid/tempo/api/status/buildinfo" >/dev/null || {
	echo "Grafana datasource tempo is not reachable" >&2
	exit 1
}

prometheus_query="$({
	curl -fsS -u "${user}:${password}" --get \
		--data-urlencode 'query=up{job="otel-collector"}' \
		"${base}/api/datasources/proxy/uid/prometheus/api/v1/query"
} 2>/dev/null)" || {
	echo "Prometheus query through Grafana failed" >&2
	exit 1
}
[[ "$prometheus_query" == *'"status":"success"'* ]] || {
	echo "Prometheus query through Grafana did not succeed" >&2
	exit 1
}
[[ "$prometheus_query" == *'"value"'* ]] || {
	echo "Prometheus has no otel-collector target sample" >&2
	exit 1
}

for service in otel-collector prometheus alertmanager tempo loki grafana; do
	[[ -n "$(mk_compose_observability ps --status running -q "$service")" ]] || {
		echo "observability service ${service} is not running" >&2
		exit 1
	}
done

echo "observability smoke passed"
