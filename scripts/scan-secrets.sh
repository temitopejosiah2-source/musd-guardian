#!/usr/bin/env bash
set -euo pipefail

root_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root_dir"

if ! command -v gitleaks >/dev/null 2>&1; then
  printf '%s\n' \
    "gitleaks is not installed; install it from https://github.com/gitleaks/gitleaks#installation and rerun scripts/scan-secrets.sh." >&2
  exit 2
fi

status=0
if ! gitleaks dir --redact --config .gitleaks.toml .; then
  status=1
fi

if git rev-parse --verify HEAD >/dev/null 2>&1; then
  if ! gitleaks git --redact --config .gitleaks.toml .; then
    status=1
  fi
else
  printf '%s\n' "History scan not run: this repository has no commits yet."
fi

exit "$status"
