#!/usr/bin/env bash
set -euo pipefail

legacy_brand="meri""know"

content_matches="$(git grep -n -I -i "${legacy_brand}" -- . || true)"
path_matches="$(git ls-files | grep -i "${legacy_brand}" || true)"

if [[ -n "${content_matches}" || -n "${path_matches}" ]]; then
	echo "legacy brand residue detected" >&2
	[[ -z "${path_matches}" ]] || printf '%s\n' "${path_matches}" >&2
	[[ -z "${content_matches}" ]] || printf '%s\n' "${content_matches}" >&2
	exit 1
fi

echo "brand residue check passed"
