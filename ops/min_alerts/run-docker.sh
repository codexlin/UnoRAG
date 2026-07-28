#!/bin/sh
set -eu

alert_root="${UNORAG_ALERT_ROOT:-/opt/unorag/ops/min_alerts}"
api_container="${UNORAG_ALERT_API_CONTAINER:-unorag-webch-api-1}"
docker_network="${UNORAG_ALERT_DOCKER_NETWORK:-unorag-webch_internal}"
documents_volume="${UNORAG_ALERT_DOCUMENTS_VOLUME:-unorag-webch_document_storage}"
docker_bin="${DOCKER_BIN:-/usr/bin/docker}"

if [ ! -f "${alert_root}/.env" ]; then
  echo "missing alert configuration: ${alert_root}/.env" >&2
  exit 1
fi

if [ ! -f "${alert_root}/check.py" ]; then
  echo "missing alert checker: ${alert_root}/check.py" >&2
  exit 1
fi

mkdir -p "${alert_root}/state"
api_image="$("${docker_bin}" inspect --format '{{.Config.Image}}' "${api_container}")"

exec "${docker_bin}" run --rm \
  --network "${docker_network}" \
  --env-file "${alert_root}/.env" \
  --mount "type=bind,src=${alert_root},dst=/alerts,readonly" \
  --mount "type=bind,src=${alert_root}/state,dst=/var/lib/unorag-alerts" \
  --mount "type=volume,src=${documents_volume},dst=/var/lib/unorag/documents,readonly" \
  --entrypoint python \
  "${api_image}" \
  /alerts/check.py "$@"
