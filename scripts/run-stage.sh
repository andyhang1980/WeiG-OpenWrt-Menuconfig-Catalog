#!/usr/bin/env bash
set -uo pipefail

stage="${1:?stage is required}"
shift
log_dir="${GITHUB_WORKSPACE:-$PWD}/failure-logs"
job_key="${CATALOG_JOB_KEY:-catalog-unknown}"
order="${CATALOG_ORDER:-00}"
log_name="${order}-${job_key}--${stage}.log"
# Write to the upload location immediately: a timeout/SIGKILL cannot run a copy.
log_file="$log_dir/$log_name"
started="$(date +%s)"

mkdir -p "$log_dir"
{
  echo "WeiG Menuconfig Catalog diagnostic log"
  echo "Source ID: ${CATALOG_SOURCE_ID:-unknown}"
  echo "Source label: ${CATALOG_SOURCE_LABEL:-unknown}"
  echo "Repository: ${CATALOG_REPO:-unknown}"
  echo "Branch: ${CATALOG_BRANCH:-unknown}"
  echo "Version: ${CATALOG_VERSION:-unknown}"
  echo "Job number: ${order}"
  echo "Job name: ${CATALOG_JOB_NAME:-unknown}"
  echo "Compatibility mode: ${CATALOG_COMPAT:-native}"
  echo "Stage: ${stage}"
  echo "Run ID: ${CATALOG_RUN_ID:-unknown}"
  echo "Run attempt: ${CATALOG_RUN_ATTEMPT:-unknown}"
  echo "Job index: ${CATALOG_JOB_INDEX:-unknown}"
  echo "Runner: ${RUNNER_OS:-unknown} ${RUNNER_ARCH:-unknown} / ${ImageOS:-unknown}"
  echo "Started UTC: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "Upstream commit: $(git -C "${GITHUB_WORKSPACE:-$PWD}/work/upstream" rev-parse HEAD 2>/dev/null || echo unavailable)"
  echo "Artifact: ${CATALOG_ARTIFACT_NAME:-unknown}"
  echo "Run URL: ${CATALOG_RUN_URL:-unknown}"
  echo "================================================================"
} >"$log_file"

trap 'echo "Stage interrupted: signal TERM/INT" >>"$log_file"; exit 143' TERM INT
# Stream progress as well as preserving it; pipefail retains the command failure.
if "$@" 2>&1 | tee -a "$log_file"; then
  echo "OK: ${CATALOG_SOURCE_ID:-unknown}/${CATALOG_BRANCH:-unknown} ${stage} completed in $(( $(date +%s) - started ))s"
  echo "Final status: success / elapsed seconds: $(( $(date +%s) - started ))" >>"$log_file"
  exit 0
fi

{
  echo "================================================================"
  echo "Final status: failure"
  echo "Elapsed seconds: $(( $(date +%s) - started ))"
  echo "Finished UTC: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "Final upstream commit: $(git -C "${GITHUB_WORKSPACE:-$PWD}/work/upstream" rev-parse HEAD 2>/dev/null || echo unavailable)"
} >>"$log_file"
echo "::error::${CATALOG_SOURCE_ID:-unknown}/${CATALOG_BRANCH:-unknown} ${stage} failed after $(( $(date +%s) - started ))s; log=${log_name}"
echo "---- key errors ----"
grep -Eiv '^fatal: Invalid revision range' "$log_file" |
  grep -Ei 'error|failed|failure|missing|not found|prerequisite|traceback|cannot|no such file' |
  tail -n 40 || true
echo "---- last 40 relevant lines ----"
grep -Ev '^fatal: Invalid revision range' "$log_file" | tail -n 40
exit 1
