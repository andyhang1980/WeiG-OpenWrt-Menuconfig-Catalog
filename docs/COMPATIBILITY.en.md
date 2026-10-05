# Compatibility Evidence Rules

`compatibility.json` records only compatibility facts that upstream Kconfig/Catalog cannot currently express and real builds have confirmed. It is not a second dependency database and does not store symbol types, N/M/Y, names, translations, dependencies, providers, hashes, or timestamps.

## Schema 6 and backward-compatible publication

The canonical document is schema 6. Its optional `preferredDisable` field names
participants to prefer disabling when a matching rule has several legal repairs.
It is a recommendation preference, not a dependency, lock, or executable action:
the shared Kconfig planner must still simulate and validate the repair. It never
disables packages merely because they exist in the Catalog.

For `all-installed`/`all-enabled`, every participant must exist and satisfy the
mode. `packageAvailability: "if-present"` skips the whole rule if any participant
is absent; it never drops a conjunct. A preferred participant that cannot be
disabled safely leaves the recommendation unavailable with an explanation,
rather than silently recommending another participant. For OWN-0002, only the
installed `autosamba` + `luci-app-samba4` pair matches; the preferred removal is
`autosamba`. Either package alone, or a module not installed in RootFS, does not
meet the file-ownership condition.

The index advertises `compatibility.v6.json.gz` to schema-6 consumers. The existing
Root-asset fast publication collects every versioned file in the selected index-contract family, verifies hash/bytes, and stages them together. Missing or stale files fail publication; a legacy-only projection must never leave modern consumers on old content.

`compatibility.json.gz` remains a schema-5 projection without `preferredDisable`,
so old readers keep the same evidence and applicability boundaries. Preventive
scope is not proof that every Source/Branch was observed failing.

OWN-0003 applies when both `luci-app-pppoe-server` and `rp-pppoe-server` are installed, preferring removal of the latter. Reviewed preventive scope covers LEDE, ImmortalWrt and hanwckf branches containing both packages. `luci-app-rp-pppoe-server` is a different application: its N state says nothing about the former. The shared planner may disable the actual selecting root first; equivalent-plan deduplication retains all `resolvedPackages` identities.

BLD-0006 uses a reviewed `preventive` policy restricted to LEDE/master, x86/64, `LINUX_6_18`, and an available failed package. A source commit change no longer silently bypasses prevention. Exact evidence preserves sources `6248ca158b90d640ece2c1a56c392cb0c430b665` and `bfec801a42f344bb7566d1f4f8960fb0cdb08350`, pinned feeds and failure references: both show Linux 6.18.54 and OpenAppFilter `a9e4637b5806b62f0e98fa6273384f849e93ae9a` calling missing `del_timer_sync`. `appfilter` shares its Source-Makefile, so disabling one output must not leave an active same-source compile root. Trigger roots come from the graph. Other sources, targets and kernels are outside this policy. Package-version auto-expiry is not supported: verify an upstream repair before narrowing or retiring the policy. Retired BLD-0004 is not reused.

## Schema 5

### Exact Lienol/25.12 evidence

OWN-0004 is restricted to source `a337df404ab3f6dc5b3e7b26a753343d3ad2f4c2`, x86/64, DEVICE_generic. Run 37233040067 and its native metadata prove five duplicate installed paths between `softethervpn-base` 4.38-r3 and `softethervpn5-libs` 5.2.5188-r1. Both complete install definitions in packages feed `fad5bd22ef3f137cad2add7904ac441291244a49` were reviewed. Both packages must be Y; no variant preference is invented. The shared planner handles actual selecting roots and leaves distinct equal-cost solutions to the user.

BLD-0007 uses the same exact environment boundary. Run 37232152405 failed applying QtBase 5.15.8 `010-gcc11.patch`, before compilation. The failed source is represented by its concrete output `qt5-core`, not an application blacklist. All Makefiles in pinned lienol feed `eb8b7938c0e91065e2d60adcc2e8b6fd2f796261` were scanned and the complete QtBase, QtTools, dynamic qBittorrent and LuCI entry definitions reviewed: dynamic uses Qt5, static does not; QtTools also has a Build-Depends edge to QtBase. The run's complete native `.packageinfo` / `.packagedeps` verifies active paths from the other installed feeds. Trigger roots remain graph-derived.

Both rules preserve all six feed revisions as evidence refs. Source/Target changes are outside scope; evidence refs are not an independently implemented feed-matching field. Verysync's non-archive download is an upstream retrieval failure, not a package ban. Firmware Workers do not consume compatibility rules to review software selections. Offline diagnostics and Probe evidence validation retain their separate responsibilities.

Readers remain compatible with schemas 2, 3, 4 and 5. The document still has only `schema` and `rules`. Schema 4 retains the existing meanings of `sourceCommits`, `targetScope`, `failure`, and `buildDependency`; schema 5 additionally permits explicitly reviewed global preventive rules:

- `policy: "preventive"` declares an applicability policy without extrapolating evidence from one environment into a claim that every upstream was observed failing.
- `environments` defines the Source/Branch/Target applicability range. `source` and `branch` may be `*`; `packageAvailability: "if-present"` makes a missing failed package not applicable rather than an error.
- `evidence` keeps the exact Source, Branch, 40-character source commit, Target scope, and short references where the failure was actually observed. Evidence boundaries remain separate from policy applicability.

Schema 4 added:

- `sourceCommits`: optional full 40-character source commits, allowing a temporary upstream failure to stop matching when the source advances.
- `targetScope`: optional exact Target `system`/`subtarget`/`profile` scope. When omitted, the rule covers every environment in the Source/Branch where the real package is present.
- `failure`: required structured evidence for `build-failure`, containing `phase`, `cause`, a stable `code`, and optional `observed` details. It explains evidence and never drives dependencies or rewrites configuration.
- `buildDependency`: optional failed-target fact for `build-failure`, requiring only one real concrete `package`. Legacy `triggerPackages` remains readable in old rules, but is no longer required, maintained, or treated as a second dependency database. Direct roots must be derived and forward-verified from the exact Source/Branch/commit typed relations graph. It is forbidden on `file-ownership` rules.

Legacy schema-2 rules keep the following fields:

- `id`: stable ID. Use `OWN-xxxx` for ownership and `BLD-xxxx` for known build failures.
- `issue`: `file-ownership` or `build-failure`.
- `match`: `all-installed` means every package is Y; `all-selected` means every package is M/Y.
- `scope`: Source to Branch-pattern arrays. Source can be named or a standalone `*`; Branch supports exact names and globs. Wildcard Source cannot mix with named Sources.
- `if`: optional Kconfig condition; never duplicate existing dependencies.
- `packages`: 1–16 real package IDs. A known one-package failure uses one ID instead of a fake participant.
- `paths`: required only for `file-ownership`; confirmed absolute duplicate-owned paths.
- `refs`: 1–8 short evidence references such as `run:31319173318`, never full logs.

The only browser execution chain is:

```text
evaluateCompatibilityRules → deriveCompatibilityPlans → applyUserIntent
```

Rules cannot contain commands, patches, or package-specific executors. The build backend cannot turn them into locks or configuration rewrites. The browser may pass `buildDependency` evidence to the generic recommendation planner; that planner still uses only existing Kconfig relations and `applyUserIntent()` to produce minimal legal operations. Users may apply the recommendation, choose N/M/Y, or force continuation after a second confirmation.

For a rule with `buildDependency`, consumers use the failed concrete `buildDependency.package` as the graph target, reverse-search current direct concrete roots, and forward-verify that every conditional path really reaches the target. Legacy `triggerPackages` is historical evidence only: it cannot expand the participant set, trigger cancellation, or replace the current graph. Unknown conditions, alternatives, select/imply paths, or virtual providers must return `inconclusive`; consumers must not guess from package, Source, or Branch names.

Every relations asset declares `relationsComplete` and its field capabilities. If the declaration is missing or `false`, the web client and Probe must defer or return `inconclusive`; incomplete relations must never be turned into a compatibility conclusion.

### Native Kconfig parsing and source-closure proof

Concrete package identity must come from native package metadata; a `PACKAGE_` prefix alone can also name a configuration suboption. Readable and compact relations preserve the same distinction. Choice details retain native declaration order through `memberOrder: "native-declaration-v1"` and the complete member list even when Target projection omits member records. Consumers cannot substitute alphabetical order or infer missing members as disabled. Linux native `conf` fixtures verify ordered choice fallback, conditional scalar/select convergence, explicit value preservation, and inactive owners. These checks support the declared contract without claiming every imported configuration or upstream firmware build has been validated.

Catalog preserves the upstream Kconfig lexer boundary: a bool default may retain the native tristate literal `m` until type-aware evaluation, comments are stripped only outside quoted strings, and `@` outside quotes is recorded as an ignored-character warning while the surrounding text continues through the ordinary expression AST. Symbols after `@` are retained; they are not wrapped in a package-selector AST. A quoted `@` remains literal. The `@(...)` form in `.packageinfo` belongs to the separate package-metadata parser and must not be mixed with the Kconfig domain.

A missing symbol may be classified as native-undefined only after the complete active source closure has been proven with no unresolved dynamic preprocessing. A real definition intentionally removed by Target projection may be external only when the full parser proof and `parsed-target-filter` provenance are both present; a parsed definition absent from the graph without that proof is projection omission and must remain `unresolved`. Native-undefined metadata retains the actual missing symbol, `nativeType: "unknown"`, boolean coercion `n`, and the original string token; unresolved names and arbitrary source labels are not external definitions. `externalSymbolDefinitions` may contain only `{symbol,type}` pairs from real parsed definitions. Unevaluated `$(shell,...)` or dynamic assignments keep `relationsComplete=false`; affected names must remain `unresolved`/`inconclusive` rather than being classified as undefined or external.

Package build closure is a separate narrow capability and does not depend on full typed Kconfig:
relations also declare `packageClosureComplete`, `packageClosureCapabilities`, and
`packageClosureValidation`. The producer may publish `complete-package-build-closure-v1` only
after exact refreshed `.packageinfo` dependency tokens (including alternatives and conditions),
virtual providers, and validated forward/reverse package edges are complete. This capability is
sufficient for a generic failed-concrete-package closure proof from `buildDependency.package`;
it must never promote `relationsComplete`. Deterministic Kconfig decisions for defaults, depends,
select, imply, visibility, choice, or MODULES still require full `relationsComplete`; otherwise
the consumer must return `inconclusive`.

Schema-4 compact contract: `records[*]` follows the published `fields` array; its pools retain typed ordered defaults/ranges, raw and AST expressions, direct/inherited visibility and dependency variants, per-definition `nodes`, separate `packageConflicts`/`kconfigConflicts`, and package capability relations. For the repaired multi-definition depends/visibility AST fields, aggregate values represent the first definition while all definitions remain in ordered variants; select/imply relations retain their existing aggregate semantics. `indexes` includes `byPackage`, `bySymbol`, `providers`, `reverseDependencies`, `reverseKconfig`, `reverseSelects`, `reverseImplies`, `forwardEdges`, and `reverseEdges`. Each edge retains `expressionAst`, `conditionAst`, nested `alternatives`, provider ownership, and an explicit `required: null` for candidate/unknown edges. Edge rows are positional source-ID rows and must not be deduplicated. `defaultsFields` retains parsed value, condition, and the original default spelling. Consumers must use the ordered definition records as evaluator input; flattened fields are compatibility projections only, and a compact-expand semantic mismatch must report bounded structural differences rather than silently pass.

Ordinary temporary-failure rules still use `sourceCommits` as their expiry boundary and may use `buildDependency` only with a full exact commit boundary. An explicitly approved schema-5 `preventive` rule instead keeps exact facts in `evidence` and controls preventive applicability independently through `environments`. With `packageAvailability: "if-present"`, a missing failed target skips the rule. The rule triggers only when the effective configuration selects a failed target that actually exists in the current Catalog and the graph proves an active user root can reach it. Unknown paths remain `inconclusive`; no static trigger participant set is restored. RootFS capacity, Runner, network, and disk failures do not belong in this document.

Normalized JSON is limited to 512 KiB uncompressed. Split by Source/Branch only through an explicit future schema migration when that limit becomes relevant; do not pre-create parallel datasets.

## Registered rules

### OWN-0001

- Scope: ImmortalWrt `openwrt-25.12` with `USE_APK` satisfied.
- Trigger: `luci-app-openvpn-server=Y` and `openvpn-openssl=Y`.
- Problem: both packages own `/etc/config/openvpn`, causing an APK ownership collision.
- Evidence: Runs `31248199953` and `31382153641`; both report `trying to overwrite etc/config/openvpn owned by openvpn-openssl`.
- Handling: generic Catalog intents compare the cascades of disabling each participant. Only a unique lowest-cost plan is recommended; force remains available.
- Removal: after upstream removes duplicate ownership and a real build confirms it, narrow scope or delete immediately.

### BLD-0001

- Scope: every ImmortalWrt and LEDE Branch: `ImmortalWrt:["*"]`, `lede:["*"]`.
- Trigger: `oscam=M/Y`.
- Problem: repeated real builds fail at link time with missing `_binary_SoftCam_Key_start/end`; current Kconfig exposes no symbol that independently disables the internal feature.
- Evidence: Runs `31319173318`, `31343335898`, `31343364994`, `31343384324`, and `31343420988`.
- Handling: the recommendation uses `applyUserIntent()` only to set `oscam` to N. Force does not patch source and may still fail.
- Removal: after one upstream range is fixed, confirm with a package probe and a real build before narrowing scope; delete after every covered range is fixed.

### BLD-0002

- Scope: ImmortalWrt `master`.
- Trigger: `luci-app-openvpn-server=M/Y`.
- Problem: the current Branch fails while compiling the `ovpn-dco` dependency at `tcp.c` against Linux 6.18. This is an upstream package-closure build failure, not the `/etc/config/openvpn` ownership collision.
- Evidence: Run `31382119111`.
- Handling: the recommendation uses generic `applyUserIntent()` only to set the package to N; force does not patch upstream source.
- Removal: delete after an upstream fix passes both a package probe and a real build.

### BLD-0003

- Policy scope: every Source, Branch, and Target/Profile, but only where the current Catalog actually provides `dockerd`; environments without `dockerd` are skipped.
- Failed target: `dockerd`. Direct entry packages are not maintained in this rule; they are derived from the exact Source/Branch/commit typed package/Kconfig/Make relations. No cancellation recommendation is produced without a proven path.
- Problem: Moby 29.6.1 passes an empty `command -v` result to `cp` while copying nested executables.
- Exact evidence: ImmortalWrt `openwrt-25.12` commit `6081813a…` in Runs `33091565296`, `32703315265`, `32702715228`, `32719724510`, `33229690268`, and `33230123378`, plus commit `1d34e7b…` in Run `33293241107`. This evidence does not claim that other Sources or Branches were observed failing.
- Removal: narrow or delete `environments` only when the global preventive policy is explicitly withdrawn. Exact evidence remains maintained as exact evidence and must not be fabricated to mirror the broader policy scope.

### BLD-0005

- Scope: exact source commit `bb287c19…` on LEDE `master`, without a Target/Profile restriction.
- Trigger: `luci-app-passwall=M/Y`.
- Problem: rootfs installation lacks matching feed packages such as `ipt2socks`, `shadowsocks-rust-*`, `simple-obfs-client`, and `v2ray-plugin`.
- Evidence: Run `32929550697`.
- Removal: delete after matching Passwall LuCI/packages feeds pass a real build.

## Maintenance, probes, and publication

Inspect upstream source and real evidence before adding a rule, then audit the same Source/Branch mechanism horizontally. A future Branch already covered by a glob needs no JSON row, but its first real probe should still be recorded. Narrow rules promptly after fixes; zombie rules are forbidden.

### Probe depth boundaries

Catalog's **Package Compatibility Probe / 软件包兼容探针** uses the Probe V3 contract and separates request truth from environment resolution. An Issue carries only direct `packageIntent` and its compact before/after `PACKAGE_*` projections. Catalog core supplies each environment's Target/Profile selectors. After cloning the exact upstream source, that Source's own Kconfig/Defconfig resolves dependencies and its Make system owns ordering, stamps, and incremental builds.

- **L1 Plugin (`config-resolve`)**: by default use the current source's official Kconfig/Defconfig resolver for the Final Root combination. The manual workflow defaults the optional A/B comparison to enabled (an explicit false keeps Final-only); when enabled, first unconditionally refresh the current Source/Branch metadata after Feeds installation, then preflight the direct plugin Root, solve the exclusion Baseline B and Final A, and retain one paired record per environment. If the Root is absent from that source/branch, record `skipped/root-absent-source`; both B and A are `not-run`, with no Target or compile stage. This proves configuration viability only and does not compile packages.
- **L2 Compile (`package-compile`)**: treat directly enabled packages as Roots, read upstream `tmp/.packageinfo` `Source-Makefile` records, deduplicate Roots produced by the same source, and enter the upstream dependency graph with one Make invocation. WeiG keeps no second Binary→Source or dependency database.
- **L3 Root system (`rootfs-integration`)**: reuse the same L2 result, then run upstream `prepare`, the complete selected `package/compile`, and `package/install` in order. The current Source Make graph produces Target, base-package, kernel-version, and package-manager prerequisites; WeiG does not assemble APK/OPKG state itself.
- **L4 Integration (`firmware-integration`)**: by default build one complete firmware from the user's Final configuration. With `comparison: { mode: "paired-exclusion", executionOrder: ["baseline", "final"] }`, the same environment Job first completes the corresponding depth with Baseline B (the selected direct plugin and automatic dependencies that Defconfig determines are no longer needed excluded), then reruns firmware, boot, and runtime stages with Final A.
- **L5 Boot (`boot-smoke`)**: after L4 succeeds, prefer the current source's own `scripts/qemustart` and require the Final firmware to reach basic userspace. No Target/QEMU parameter table is maintained.
- **L6 Runtime (`runtime-health`)**: after L5, use a reliable control channel to check init/procd, basic mounts, uptime, ubus when available, and Roots actually built into Final. When a serial console requires activation, activate it and wait for the root prompt before sending health commands. A missing reliable control channel is `skipped`.
- **L7 Reboot (`reboot-validation`)**: after L6, reboot Final normally, wait for a second boot, and repeat the same health checks. Real sysupgrade flashing is not performed.
- **L5-L7 firmware and virtual-boot adaptation**: after firmware completes, scan the actual artifacts under `bin/targets/<target>/<subtarget>/`, never by an `openwrt-*` brand prefix. Only a filename with explicit rootfs-only semantics may be passed to `scripts/qemustart --rootfs`; combined/combined-efi, factory, sysupgrade, and vendor `.bin` files remain inventory evidence and must not be treated as a raw RootFS. Stream `.gz` outputs through a bounded decompressor into a Probe-owned temporary directory. Pass real paths only through parser-verified official options supported by the current source's `scripts/qemustart`, such as `--rootfs` or `--kernel`, and only when a safe RootFS exists; comments and usage text do not establish capability. A combined-only output or missing safe path is `skipped/virtual-boot-unsupported` with `deepestPassedLevel=L4`; a deterministic Baseline-B Guest boot failure is `blocked/base-profile-boot-failure`, while a Final-A Guest boot failure is `incompatible/final-boot-failed`; QEMU, permission, and host-resource failures are `unresolved`. The phase-aware result prevents a plugin-induced Final-A boot failure from being mislabeled as an upstream Base Profile blocker.

By default L2-L7 reuse completed Stages; they do not repeat builds merely to increase depth. With A/B enabled, B→A still shares the same Job's bootstrap, source, feeds, and incremental Make work tree, while each phase has separate logs and evidence. Before B, every A/B depth must unconditionally regenerate the current Source/Branch `tmp/.packageinfo` after Feeds installation; an existing file is stale-cache input and must never be reused. A refresh failure or a missing file after refresh is `metadata-unresolved/inconclusive` and keeps the Job failed. Preflight then parses only the refreshed metadata; it must not turn an empty Root set into a Target/RootFS/firmware build. A missing Root is `preflight-skipped`, so both B and A are `not-run` and the Summary does not say “Baseline B failed”. When Baseline B has no direct Root, record `baseline-ready/no-direct-roots`: do not compile a plugin or claim that every Base Profile package was built. A B `prepare` or shared-target failure short-circuits A; when deterministic evidence confirms a Base Profile/upstream fault, record `blocked`, mark the plugin `not-evaluated`, and never attribute it to the plugin. If B is only `skipped/virtual-boot-unsupported` because L5-L7 capability is unavailable, Final A still completes at least L4 and the paired result reports “firmware build passed, runtime not covered”; this is not a Base Profile blocker. Only when B succeeds and A fails, or an isolated B counterfactual replay succeeds while A fails, may the result be attributed to the plugin. A reruns the corresponding install/image/qemu stages at L3-L7. Every depth requires the selected Source's official resolver: L1 uses `scripts/config/conf`, while L2-L7 use `make defconfig`. A request cannot disable this step. Only direct Probe Roots must retain their requested `m/y` states; automatic dependencies such as `libatomic` and `libusb-1.0` exist only in each environment's resolved configuration and evidence, never in the Issue request.

Probe V3 carries direct `packageIntent`, compact `baselinePackageConfig`/`packageConfig` projections derived from that Intent, mandatory Defconfig, five-dimensional environment constraints, and coverage controls. The complete 836 Advanced menuconfig entries or 276 post-Defconfig entries are browser interaction state, not a Probe request. The Runner accepts no dependency list, build order, or second packages/roots authority. After validation, the server derives the compact Root configuration again for all L1-L7, so automatic dependencies carried by an older client do not become execution authority. Legacy `WEIG_PACKAGE_PROBE_STATE_V2` requests are rejected.

Each Probe Job clones the Catalog-pinned upstream commit first, then detects Python and GCC capability from that source's `include/prereq-build.mk`; Source/Branch names must not select the runtime. Generic Runner build dependencies cover the later package, RootFS, and firmware stages, while a compatibility runtime is installed only when the detected contract requires it. Upstream `make prepare-mk` then validates host prerequisites that do not depend on a Target/Profile `.config`. Evidence records direct Root count, package count after Defconfig, Python identity, and compiler identity separately.

Environment scope is resolved dynamically from real Catalog structure. Each of **Source / Branch / Target System / Subtarget / Target Profile** can independently be wildcarded or constrained. Target System, Subtarget, and Profile come from structured Catalog core fields; Probe never reverse-parses strings such as `x86/64`. A wildcard stores a rule rather than today's leaf list, so newly discovered Branches, Targets, and Profiles naturally join the scope later. Impossible combinations are not applicable, not incompatible.

Coverage has two modes. **Auto** performs reproducible hierarchical maximum-coverage sampling within an administrator budget. If candidates fit the budget, all run; otherwise only dimensions left wildcarded by the user are diversified across Source, Branch, Target System, Subtarget, and Profile. The sampling seed is recorded as evidence and a later Run may rotate the sample. Defaults in `.github/automation-policy.json` are L1=40, L2=200, L3=100, L4=30, and L5=10, with no batch above 256; L6/L7 require an explicit limit until real duration measurements exist. **Exhaustive** covers every real candidate; scopes above 256 stay pinned to the first Catalog data commit and sampling seed and continue sequentially in batches of at most 256 instead of creating thousands of concurrent jobs.

Sampled and exhaustive conclusions are distinct. All-success or all-failure samples are only `sampled-compatible` or `sampled-incompatible`; `fully-compatible` and `fully-incompatible` require complete coverage. Mixed success/failure is `partially-compatible`. Per-environment `compatible`, `incompatible`, `blocked`, and `skipped` are complete domain conclusions. `blocked` means a confirmed Base Profile/upstream shared-environment failure; the plugin was not evaluated and the row is excluded from the plugin-incompatibility rate. The Summary reports plugin incompatibility, Base Profile blocked, and execution `unresolved` separately. Downloads, disk exhaustion, Runner failures, unresolved metadata, cancellation, and timeouts remain `unresolved/inconclusive`; incomplete evidence keeps the Job failed. Evidence is grouped Source → Branch → Target System → Subtarget → Target Profile, which can localize a failure without automatically declaring an upstream bug or mutating `compatibility.json`.
Summary success rate is `compatible / (compatible + incompatible + blocked + inconclusive)` with `skipped` excluded; evaluated compatibility is `compatible / (compatible + incompatible)`; evaluation coverage is `(compatible + incompatible) / applicable`; plugin-cause rate is confirmed plugin-caused incompatible rows divided by `incompatible`. Notes must explain all-compatible, all-incompatible, blocked, skipped, replay-unavailable/inconclusive, unresolved, and L4-passed-but-L5-L7-uncovered scopes.

Execution status and compatibility conclusion are separate axes. `target-prerequisite-failure`, `package-compile-prerequisite-failure`, `rootfs-*-prerequisite-failure`, and `firmware-prerequisite-failure` retain the innermost failed target, generic cause, failure fingerprint, and deterministic error summary, for example `package/kernel/linux`, `kernel-prerequisite`, and `module .../crypto/geniv.ko is missing`. When the failed target is shared by B and A, replay it in an isolated Baseline-B environment: if B fails too, record `blocked`; if B succeeds and A fails, record plugin-induced `incompatible`. A direct Root or A-added dependency failure is respectively a direct/dependency plugin incompatibility. Replay is explicitly staged as `replay-bootstrap`, `replay-prepare`, and `replay-target`; an identified, complete-evidence replay capability gap before the shared Target is entered is `counterfactual-replay-unavailable/inconclusive`, so the single-environment Job may stay green but the row is not counted as compatible. Unknown failures, missing evidence, or Runner crashes remain `counterfactual-unresolved` and red. A blocked Baseline B explicitly records Final A as `not-run` and does not increase the plugin-caused rate. A failure refreshing metadata after Feeds installation must be recorded as a structured `metadata-unresolved` issue (`phase: preflight`), and Summary Notes must explicitly say “Feeds 后元数据刷新失败 / after-Feeds metadata refresh failed”; it is neither a missing-plugin skip nor a reportable green conclusion. Network, downloads, disk, OOM/Killed, Runner, timeout, missing metadata/evidence, and unattributed failures remain operational/unattributed `unresolved/inconclusive` and must stay red. Final compatibility conclusions read normalized evidence only; Job green/red is never a substitute for the evidence conclusion.
The older `reported inconclusive` prerequisite vocabulary remains accepted only for backward-compatible evidence validation; newly classified deterministic Base Profile failures are emitted as `blocked`, while operational/unattributed inconclusive evidence remains unresolved and red.

The Issue gateway still treats the real Issue author and repository permission as authorization truth. It verifies the V3 state token, SHA-256, and Issue identity, then dispatches the matching code channel; continuation batches remain pinned to the first Catalog data commit. Owner/admin requests may use the administrator parallel budget, write/maintain collaborators remain capped at three concurrent jobs, and visitors cannot start the Matrix. The requester or a write/maintain/admin collaborator can reply with exactly `/cancel`; the cancellation marker stops the active Run and prevents future batches. Normalized evidence remains for 60 days and complete logs for 30 days.

Failure diagnosis follows upstream incremental build behavior. Expensive targets first use the Runner CPU count plus one; failures are reproduced against the **same upstream Root targets** with `-j1 V=s BUILD_LOG=1`, reusing the same work tree and stamps. The old Final-PACKAGE compile loop, fallback-Target loop, and `reduceFailureSet()` / `reductionMaxAttempts` no longer belong to Probe: WeiG does not split dependency closure or search for a synthetic minimum failing package set.

Code `main` and production data `catalog-data` retain independent lifecycles. Builder `main` writes only `catalog-candidate`, runtime/probe `main` reads `catalog-data`, and production data is promoted only by the manual Production Gate. Ordinary pushes, schedules, and Probe experiments cannot bypass that gate.

GitHub-hosted jobs still have platform time limits. Per-depth timeouts are declared in `.github/automation-policy.json`; a timeout yields only `inconclusive`, never package-failure evidence.

The hard order for a new plugin or rule is: reuse existing Catalog data, audit the same data type/execution path/risk class, run the package probe first, and only then maintain a generic rule from real evidence. AutoBuild must not contain package names or dedicated executors.

When only `compatibility.json` changes, the Workflow sparse-checks out `index.json` and `compatibility.json.gz` and runs `build-index.mjs --compatibility-only`, without the Source/Branch matrix. A `curated-sizes.json`-only change similarly runs `--applications-only` for `applications.json.gz`. Generator, Source-policy, or Workflow changes still run the complete matrix.

Chinese and English rule documentation must remain synchronized. 中文：[COMPATIBILITY.md](COMPATIBILITY.md)
