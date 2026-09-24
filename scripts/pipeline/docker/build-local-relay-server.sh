#!/bin/sh
set -eu

if [ "$#" -gt 1 ]; then
  printf 'Usage: %s [image-tag]\n' "$0" >&2
  exit 2
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/../../.." && pwd)
image_tag=${1:-happier-relay-server:patched-allowlist-fix-slim}

exec docker build \
  --platform linux/amd64 \
  --progress plain \
  --target relay-server-local-source \
  --tag "$image_tag" \
  --file "$repo_root/Dockerfile" \
  "$repo_root"
