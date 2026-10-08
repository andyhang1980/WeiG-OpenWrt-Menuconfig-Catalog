#!/usr/bin/env bash
# Append third-party feeds that the upstream feed config does not already declare.
# 上游 feed 配置已声明的同名 feed 不重复追加，避免 scripts/feeds 报 Duplicate feed name。
set -euo pipefail

extra="$GITHUB_WORKSPACE/extra-feeds.conf"
if [[ ! -f "$extra" ]]; then
  echo "ERROR: extra feeds list is missing: $extra" >&2
  exit 1
fi
if [[ ! -f feeds.conf ]]; then
  if [[ ! -f feeds.conf.default ]]; then
    echo "ERROR: neither feeds.conf nor feeds.conf.default exists" >&2
    exit 1
  fi
  cp feeds.conf.default feeds.conf
fi

# Print the feed name declared by each src-git line (skips method and flags).
feed_name() {
  awk '{ sub(/#.*$/, ""); if ($1 ~ /^src-git/) { i = 2; while ($i ~ /^--/) i++; if ($i != "") print $i } }'
}

existing="$(feed_name < feeds.conf | sort -u)"
while IFS= read -r line || [[ -n "$line" ]]; do
  declaration="${line%%#*}"
  if [[ -z "${declaration//[[:space:]]/}" ]]; then
    continue
  fi
  name="$(printf '%s\n' "$declaration" | feed_name)"
  if [[ -z "$name" ]]; then
    echo "ERROR: unsupported feed declaration: $declaration" >&2
    exit 1
  fi
  if printf '%s\n' "$existing" | grep -qxF "$name"; then
    echo "[extra-feeds] skip $name: already declared by the upstream feed config"
  else
    printf '%s\n' "$line" >> feeds.conf
    existing="${existing}"$'\n'"${name}"
  fi
done < "$extra"
./scripts/feeds list -sf > /dev/null
echo "[extra-feeds] feeds.conf ready with $(feed_name < feeds.conf | wc -l | tr -d ' ') feed(s)"
