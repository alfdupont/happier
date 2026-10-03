#!/bin/sh
set -eu

if [ "$#" -gt 1 ]; then
  printf 'Usage: %s [image-tag]\n' "$0" >&2
  printf 'HAPPIER_DOCKER_BUILD_MEMORY sets the build memory cap (default: 16g).\n' >&2
  exit 2
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/../../.." && pwd)
image_tag=${1:-happier-relay-server:patched-allowlist-fix-slim}

# The default builder runs inside dockerd, where build steps have no memory
# limit and count against the daemon itself: the web export can get the whole
# daemon OOM-killed, along with every running container. Build in a dedicated
# BuildKit container with a hard cap instead. Setting memory-swap to the same
# value forbids swapping beyond it, so an oversized build fails fast.
memory_limit=${HAPPIER_DOCKER_BUILD_MEMORY:-16g}
case "$memory_limit" in
  ''|*[!0-9bkmgBKMG]*)
    printf 'Invalid HAPPIER_DOCKER_BUILD_MEMORY: %s (expected e.g. 16g)\n' "$memory_limit" >&2
    exit 2
    ;;
esac

builder_name=happier-relay-build
if ! docker buildx inspect "$builder_name" 2>/dev/null \
  | grep -qF "memory=\"$memory_limit\" memory-swap=\"$memory_limit\""; then
  # Recreate on first use or when the cap changed; keep the build cache.
  docker buildx rm --keep-state "$builder_name" >/dev/null 2>&1 || true
  docker buildx create \
    --name "$builder_name" \
    --driver docker-container \
    --driver-opt "memory=$memory_limit" \
    --driver-opt "memory-swap=$memory_limit" >/dev/null
fi

exec docker buildx build \
  --builder "$builder_name" \
  --load \
  --platform linux/amd64 \
  --progress plain \
  --target relay-server-local-source \
  --tag "$image_tag" \
  --file "$repo_root/Dockerfile" \
  "$repo_root"
