#!/bin/sh
set -eu

target_arch="${1:?target architecture is required}"
server_dir="${2:?server directory or '-' is required}"
node_modules_dir="${3:-$server_dir/node_modules}"

case "$target_arch" in
  amd64)
    sqlite_engine="libquery_engine-debian-openssl-3.0.x.so.node"
    sharp_arch="x64"
    ;;
  arm64)
    sqlite_engine="libquery_engine-linux-arm64-openssl-3.0.x.so.node"
    sharp_arch="arm64"
    ;;
  *)
    echo "Unsupported TARGETARCH: $target_arch" >&2
    exit 1
    ;;
esac

if [ "$server_dir" != "-" ]; then
  rm -rf "$server_dir/generated/mysql-client" "$server_dir/prisma/mysql"
  find "$server_dir/generated/sqlite-client" -type f -name '*.node' ! -name "$sqlite_engine" -delete
fi

rm -rf \
  "$node_modules_dir/@img/sharp-libvips-linuxmusl-$sharp_arch" \
  "$node_modules_dir/@img/sharp-linuxmusl-$sharp_arch"
