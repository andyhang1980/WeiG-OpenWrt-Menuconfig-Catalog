#!/usr/bin/env bash
set -Eeuo pipefail

mode="${1:-metadata-only}"
if [[ "$mode" != "metadata-only" ]]; then
  echo "Unsupported metadata mode: $mode" >&2
  exit 2
fi

# Catalog extracts Kconfig/Perl metadata and never compiles host tools or
# firmware. Every upstream therefore uses the same metadata-only prerequisite
# boundary; this is independent of Source/Branch names and covers future
# branches that retain obsolete host Python/GCC checks.
mkdir -p staging_dir/host
touch staging_dir/host/.prereq-build
echo "Metadata-only prerequisite boundary enabled."

# Catalog only needs upstream target/package metadata. Do not resolve or rewrite
# an OpenWrt .config here; build requests provide their own complete config.
node "$(dirname "${BASH_SOURCE[0]}")/native-installation-metadata.mjs" "$PWD"
make prepare-tmpinfo FORCE=1
test -s tmp/.targetinfo
test -s tmp/.packageinfo
