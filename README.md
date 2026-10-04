# WeiG OpenWrt Menuconfig Catalog

## Source families and runtime publication / 版本族与运行资产

| Source | Discovered branches | Default selection |
| --- | --- | --- |
| iStoreOS (`istoreos/istoreos`) | `istoreos-YY.MM`, newest first; no patch, experimental, `openwrt-*`, main/master branches | Upstream default when it belongs to the family |
| Lienol (`Lienol/openwrt`) | `YY.MM`, newest first; no patch or experimental branches | Upstream default when it belongs to the family |

`catalog.config.json` declares `branches.versionFamily` and `preferDefault`;
existing discovery, metadata-only bootstrap, exact feeds, native Profile baseline,
Kconfig and package graph generation are shared. A future family version is
discovered automatically. A configured source becomes usable only after native
generation/validation publishes a complete snapshot; configuration alone is not
proof that every Profile or firmware builds. No other source's package sizes are borrowed.

版本倒序和默认选择分开：iStoreOS 当前最新发现 `25.12`，官方默认仍为 `24.10`；
这些是发现结果，不是网页写死的版本表。两新源复用原生成链，网页选择具体 Profile 后
读取精确原生 baseline，不在浏览器再跑 defconfig。未来版本族自动发现；生成未成功的环境
不作为可用数据。没有可信同源官方大小索引时明确未知，不借用其它源数字。

New snapshots keep required contract/duplicate/translation/relations evidence in
Actions artifacts, not the runtime data branch. Existing graph and legacy bundle
contracts remain while older consumers still require them; immutable historical
snapshots remain addressable. Modern translation reads full text from menu/help
(`complete-text-v1`) and language projections, without decoding a graph to discover
text; old snapshots retain the legacy path, and compatibility bundles are updated
one branch at a time with non-text fields preserved.

网页先显示验证过的 core 选择器，依赖图与 Native baseline 并行加载，菜单/长说明/语言/
当前架构大小仍按需加载，不把所有数据合成 ZIP。代表性真实 `ImmortalWrt/openwrt-25.12`
core+compact graph+profiles 为 6,659,160 bytes gzip；合并 gzip-9 为 6,657,709 bytes，
只省 0.022%，不值得牺牲首屏、按需加载和独立缓存。该比较不等于所有源的浏览器性能承诺。

## Reproducible inputs and parallel Native Profiles

Each new branch snapshot records `buildInputs` and `inputsHash`: the exact source
commit and the ordered feed methods, URLs, options and commits used by generation.
Profile baselines and the published branch share that receipt. Consumers must use
those inputs instead of updating feed branches to their latest commits.

Native Profile generation uses the existing generator through
`scripts/profile-config-pipeline.mjs` and `.github/workflows/catalog-branch.yml`:
prepare one source tree, generate bounded shards, merge globally, run the existing
global parity sample in isolated shards, then finalize. Branches with more than
700 Profiles use four shards by default; repository variable
`CATALOG_PROFILE_SHARDS` accepts `1`, `4`, or `8`. Smaller branches stay inline.
Parallelism does not change baseline semantics, grouping, or published formats.
Missing/mixed shard receipts cannot publish a complete snapshot. Stage logs remain
available on failure or timeout. This is parallel jobs within one workflow run,
not several competing publishers.

新快照记录源码与有序 feeds 的精确提交，Native Profile 与分支资产共享同一输入凭据。
大分支默认四路任务，可设为八路；先全局合并，再按原有全局样本验证，最后统一发布。
小分支原地执行。并行不改变配置语义或压缩格式，缺分片不能伪装完整快照，超时保留阶段日志。

## Dynamic targets and 11-language translations / 动态目标与 11 语翻译

Concrete package identity comes from native package metadata, not the `PACKAGE_`
prefix: package configuration suboptions remain Kconfig-only in readable and compact
relations. Choice membership preserves native declaration order (`native-declaration-v1`)
and members outside the Target projection. Linux native `conf` regression fixtures check
ordered fallback, conditional defaults, explicit values, and inactive owners; they do not
claim exhaustive parity for all upstream configurations.

真实软件包身份以原生包元数据为准，不能靠 `PACKAGE_` 前缀猜测；配置子选项在可读和
紧凑图中仍为 Kconfig-only。Choice 保留原生声明顺序及 Target 投影之外的成员。
Linux 原生 `conf` 回归覆盖顺序回退、条件默认值、显式值及非活动 owner，
不宣称已经穷尽所有上游配置的等价性。

Dynamic Kconfig defaults are expanded by the selected upstream's own parser in
a disposable build directory, without reading or writing `.config`. Catalog
replays the observed expansions against their source locations and retains the
trace. Missing APIs, ambiguous replay, or unresolved expressions fail closed;
neither JavaScript shell emulation nor package-specific defaults are used.
Local replay tests and the Linux native-parser integration test are separate
from full Source/Branch generation validation.

动态 Kconfig 默认值复用所选上游原生解析器，在临时构建目录中展开，不读写 `.config`。
Catalog 按源码位置重放并保留展开证据；API 缺失、重放歧义或未解析表达式继续阻断，
不自行模拟 shell，也不按包名补默认值。本地重放测试、Linux 原生解析器集成测试和
完整 Source/Branch 生成验证分别报告，不互相替代。

The catalog is the data authority for source branches, Target selectors and the complete
Kconfig menu tree. The web customizer does not keep source branches, targets or menu entries
in JavaScript.

Catalog 是源码分支、Target 动态选择器和完整 Kconfig 菜单树的数据权威；主网页不在
JavaScript 中写死分支、Target 或菜单项目。

- Canonical English comes from upstream `.targetinfo`, `.packageinfo` and `Config.in`.
- Curated application titles and descriptions in all 11 languages come from
  `translations/zh-CN.json`; the filename is retained for compatibility.
- Main menu/category labels for all 11 UI languages come from `translations/menu-i18n.json`.
- The visible menu and the complete symbol table are separate: no-prompt/hidden Kconfig symbols remain out of the normal tree but are published for Advanced search and validation.
- Runtime relations retain the schema-4 `graph` for existing consumers and advertise an optional schema-5 `graphCompact` asset (`interned-definitions-edge-rows-v1`) for newer consumers. Interned definition/expression tables and positional edge rows preserve the same typed Kconfig values, ordered conditional defaults/ranges, visibility and choice conditions, per-definition provenance, virtual capability identity, and typed forward/reverse edges. Schema 3 remains readable for old snapshots. Every asset declares `relationsComplete`; a missing/false declaration is fail-closed (`deferred`/`inconclusive`) rather than guessed.
- Package build closure is a separate narrow contract: `packageClosureComplete` and
  `packageClosureCapabilities` are true only after exact `.packageinfo` dependency tokens
  (including alternatives/conditions), virtual providers, and verified forward/reverse package
  edges pass validation. `complete-package-build-closure-v1` is sufficient for a
  `buildDependency` failed-package closure proof; it never makes typed Kconfig evaluation
  complete. `relationsComplete` remains independently required for deterministic defaults,
  depends/select/imply, visibility, choice, and MODULES decisions.
- Options carry `depends on`, `visible if`, `select`, `imply`, defaults, ranges and parent paths.
  The parser keeps effective `depends` for existing consumers and also exposes the source
  boundary as `directDepends` plus `inheritedDepends`; prompt guards are kept separately in
  `promptIf`, and menu/choice visibility in `visibleIf` (with menu-only `menuVisibleIf`).
  Choice `reset if` conditions are preserved as `resetIf` plus typed `resetIfAst` through the
  readable graph and compact schema-4 round trip. Source globs follow native Kconfig scope:
  ordinary `source` globs are rooted at the source tree, `rsource` globs at the including file,
  and an unmatched glob is an empty include while a missing literal remains structural evidence.
  Top-level Kconfig assignments and evaluator-owned `$(...)` expressions are retained in
  `validation.variableAssignments` and `validation.dynamicExpressions`; the catalog never
  executes shell expressions or guesses their values. `relationsComplete` asserts producer-data
  completeness; consumers must still fail closed when evaluator-owned dynamic expressions cannot
  be reduced.
  A `comment` is a standalone Kconfig node, so its conditions can never leak into the
  preceding or following symbol. These fields are source/parser metadata and are retained by
  compact schema 4; prompt or visibility conditions are never treated as value dependencies.
- Repeated Kconfig definitions are merged by symbol. Only explicit, incompatible types are hard conflicts; split declarations such as `tristate` in one file and `prompt` in another are legal and retained as one option.
- Native lexer boundaries are preserved: a bool default may retain the native tristate literal `m` until type-aware evaluation, comments are removed only outside quoted strings, and `@` outside quotes is recorded as an ignored-character warning while the surrounding expression remains an ordinary Kconfig AST. Symbols after `@` are not discarded or wrapped as a package-selector AST; quoted `@` remains literal. The `@(...)` syntax in `.packageinfo` is a separate package-metadata parser domain.
- Native source-closure proof is explicit. A complete active-root parse with no unresolved dynamic preprocessing distinguishes a symbol that is genuinely undefined in that closure from a symbol omitted by the Catalog projection. An intentionally Target-filtered definition may be external only when the full parser proof and `parsed-target-filter` provenance are both present; a definition omitted from the graph without that proven mapping remains unresolved. Undefined metadata keeps the symbol identity and records boolean coercion `n` plus the original string token; external types never come from a source label or an unknown prefix. Unevaluated `$(shell,...)`/dynamic assignments keep `relationsComplete=false`; they cannot be used to classify undefined or external symbols.
- Compact relations retain the first-definition aggregate for the repaired depends/visibility AST fields, while select/imply relations keep their existing aggregate behavior; every definition remains available in ordered variants. Edge rows are positional and are not deduplicated because forward/reverse indexes refer to their source IDs. `defaultsFields` keeps the original default spelling alongside parsed value and condition, so semantic round-trip validation can report bounded structural differences instead of silently accepting a mismatch.
- Package options also carry upstream `.packageinfo` `Conflicts:` metadata, so consumers can reject impossible `y/y` package combinations before compiling.
- Package metadata follows the selected upstream's native `metadata.pm` projection: the last concrete package declaration wins, while virtual-provider membership retains the native accumulated registrations. Raw `Provides:` tokens and canonical capability identities remain separate; a capability such as `@base-files-any` is not a Kconfig symbol. Description/Config multiline blocks cannot create phantom package records. Alternative, conditional, build-only, and versioned tokens retain their field-specific meaning; conflicts are not expanded into invented aliases. Provider projection is tested against native metadata generations, independently of complete Kconfig/firmware parity.
- Target selectors are emitted as an ordered schema and tree. Empty trailing selectors are hidden,
  one-option selectors are auto-selected, and extra future selectors can be appended without HTML changes.
- Every generation writes a `*.translations.json` coverage report retained in Actions diagnostics, not republished as runtime data.
- Catalog schema 6 splits each branch into `core`, `graph`, optional `graphCompact`, `menu`, `hidden`, `help`, and per-language menu gzip assets. The published index records every shard's compressed byte count, SHA-256, and immutable `assetRef` Git commit. New consumers initially fetch `core + graphCompact` when advertised; old consumers continue using `core + graph`. Advanced menu text and long help are loaded on demand. The schema-5 monolithic gzip remains temporarily as a compatibility fallback. A corrupt advertised compact asset is an error, not permission to silently mix assets from another snapshot.
- Confirmed facts that upstream Kconfig cannot express live in the small global `compatibility.json`; it references package IDs only and never duplicates symbols, states, names, dependencies, or hashes. See [中文规则说明](docs/COMPATIBILITY.md) and [English rules](docs/COMPATIBILITY.en.md).
- The daily translation workflow reads branch assets from `index.json`, reuses `i18n-cache.json`, and translates only new or changed descriptions. Full modern text comes from menu/help and language projections; older snapshots still read one legacy branch at a time. Compatibility projections are updated one branch at a time; parsed graphs are never retained across branches. An early run receipt distinguishes an interrupted job from a completed translation report.
  Argos runs locally by default without a key; Azure is an explicit optional engine. Successful
  translations are published even when a batch is incomplete; remaining descriptions are kept in
  `translation-retry-queue.json` and retried first on the next run. A translation job is limited to
  60 minutes, with a shared 50-minute translation budget and at most 5000 descriptions per run.
- Curated application names/usages are joined by every known source package symbol. Text that
  should remain a technical English name is left untranslated instead of showing a fake tooltip.

英文以各上游源码为准；精选 Applications 的 11 语名称与用途由 Catalog 维护，11 语菜单
分类维护在 `translations/menu-i18n.json`。每日翻译任务复用历史翻译缓存，只翻译新增或变化
文本；额度不足或服务异常时保留官方英文并写入待译统计与重试队列，已完成部分仍可提交。
软件包选项也带有上游 `.packageinfo` 的 `Conflicts:` 元数据，使用方可在编译前拒绝不可能的 `y/y` 组合。
- 原生 Kconfig 词法边界必须保留：bool default 可以先保留原生三态字面量 `m` 再按类型求值；注释只在引号外删除；引号外的 `@` 只记录 ignored-character 警告，周围仍解析为普通 Kconfig AST，`@` 后面的符号不能丢失，引号内的 `@` 保持字面量。`.packageinfo` 中的 `@(...)` 仍属于独立的软件包元数据解析域。
- 没有未求值动态预处理的完整 active source closure 才能证明符号确实在该源码闭包中未定义。明确被 Target projection 过滤的定义，只有同时具备完整 parser proof 与 `parsed-target-filter` provenance 才能作为 external；既未进入 graph、又没有这份证明的已解析定义仍必须保持 unresolved。undefined 元数据保留原符号身份，同时记录 bool 求值 `n` 与原始 string token；external 类型不能凭 source 标签或前缀猜测。`$(shell,...)`/动态赋值未实现求值时保持 `relationsComplete=false`，不能把名称分类为 undefined 或 external。
- compact relations 中，本轮修复的 depends/visibility AST 使用首个定义的 aggregate，其它定义保存在有序 variants；select/imply 继续按既有关系语义聚合。edge 是按源 ID 定位的 positional row，不能去重。`defaultsFields` 同时保留 default 原文、解析值和条件，round-trip 发现差异时只报告有界结构差异，不静默吞掉 mismatch。
- 翻译任务每天上海时间 04:37 独立运行，不因普通 Push 或 Catalog 发布重复启动。
  自动与手动任务默认 `500×5` 批；手动任务可选择代码分支与 `catalog-data/catalog-dev/catalog-staging/catalog-fix` 数据通道，并可设置每批
  `100–5000` 条、`1–20` 批，但单次总数最多 5000 条。任务上限 60 分钟，全部批次共享
  50 分钟翻译预算；默认 `each-batch`，每个成功批次立即提交。`final` 可改为最后统一提交。
  取消、零结果或校验/发布失败不会提交当前批次；更新仍按文本指纹跳过未变化内容。旧单体按分支依次读取、释放和写回，不同时驻留所有关系图；预先写入运行回执，避免中断后把缺少最终报告误报为另一故障。

Refresh the curated application union manually after reviewing upstream application IDs and Chinese/English descriptions:

```bash
npm run refresh:applications -- --channel dev
# Review diagnostics/curated-applications-refresh.json, then deliberately write:
npm run refresh:applications -- --channel dev --write
```

The refresh tool verifies menu shards and merges shared application descriptions across Source/Branch entries. It is report-only unless `--write` is explicit; `--source` and `--branch` accept exact IDs/names or `*`. `applications.json.gz` supplies descriptions/groups and translated Probe UI, not package availability or aggregate sizes. Official OPKG/APK indexes feed branch size assets during generation. The obsolete `curated-sizes.json`, aggregate refresh script and weekly size workflow are retired. Probe package choices come from current Catalog/Kconfig state.

`curatedGroups` is the ordered group authority. Published applications keep only groups used by at least one curated application; refresh prunes empty groups, and validation rejects empty or duplicate groups. Group changes belong in `catalog.config.json` and refresh metadata, never in AutoBuild package-name conditions.

The selectable branch application projection is the intersection of native LuCI
Kconfig options and the branch's concrete `.packageinfo` package index. A
`PACKAGE_luci-app-*` configuration suboption is not an application or a package
size record. Shared descriptions/groups supplement this projection; they do not
make a package available in another Source/Branch/Target. The full menu and typed
relations remain available to Advanced menuconfig.

Package-size observations come from official binary indexes, not source file
bytes. The OPKG/APK collector intersects official architectures with native
Targets and admits only exact native package versions. Each architecture has an
independent positional gzip asset advertised as `packageSizes:<arch>`; the
default `packageSizes` contract remains readable. Collection uses a bounded
deadline and four architecture workers; unavailable coverage does not block
generation. Consumers match Source/Branch/commit/architecture and distinguish
archive from installed bytes. Count only final-Y concrete packages. Missing
observations are unknown, never zero. Capacity percentages require complete
installed-size coverage; they do not predict compressed firmware size.

Repository discovery is data-driven through `curatedSizeSources`: inspect trusted
architecture/feed listings, same-version-family releases and native Target
repositories, with declared archive fallbacks. Preserve every package/version
pair so a later repository cannot shadow the native version; conflicting
installed-size observations for one identity remain unknown. Stable and future
`openwrt-*` branches and snapshot lanes share the same collector. Lean LEDE and
other forks without a declared matching official index remain explicitly
unavailable; upstream OpenWrt binaries are not substitutes. No firmware build or
additional Worker dependency gate is required for these optional observations.

`curatedGroups` 是分组顺序的权威数据。公开应用只保留至少含一个精选应用的分组；刷新工具自动清理空分组，校验器拒绝空分组和重复分组。分组调整必须同步维护 `catalog.config.json` 与刷新元数据，禁止在 AutoBuild 按软件包名特判。

为 WeiG OpenWrt 在线定制器生成静态 menuconfig 目录。项目本身不编译固件。

目录内容来自 ImmortalWrt、OpenWrt、Lean LEDE 与
`hanwckf/immortalwrt-mt798x` 各收录分支生成的 `tmp/.targetinfo`、
`tmp/.packageinfo` 和顶层 `Config.in` 树，包括：

- Source / Branch / Target System / Subtarget / Target Profile
- 顶层 `make menuconfig` 中可见的 bool、tristate、choice、string、int、hex，以及无 prompt 的隐藏 Kconfig 符号
- 可见菜单与完整符号集合分离；隐藏项不会污染普通菜单，但会进入 Advanced 搜索和配置验证
- `depends on`、`select`、`imply`、`default`、`range`、choice、provider、冲突、反向依赖与菜单路径
- 解析器区分有效依赖 `depends`、当前声明的 `directDepends`、作用域继承的
  `inheritedDepends`，并把 `prompt ... if` 保存为 `promptIf`、菜单/choice 的可见条件保存为
  `visibleIf`（仅菜单条件为 `menuVisibleIf`）。`comment` 是独立的 Kconfig 节点，其条件
  不会串入前后配置项。上述字段属于源码解析元数据；当前 compact relations 只序列化取值
  关系，使用方不得把 prompt 或可见条件当成取值依赖。
- `menu/endmenu` 显式层级，以及 `menuconfig` 通过正向 `if/depends` 形成的隐式父子层级
- 软件包 Kconfig 选项及其依赖关系

网页已经用动态 Target 选择器提供设备/Profile，因此目录不会重复发布 `Target Devices` 菜单和对应的数千个 Kconfig 项。普通菜单仅消费可见选项；完整关系表仍发布隐藏 Kconfig 与 packageinfo-only 软件包，使消费方可以通用处理语言包残留、依赖链、choice 和 provider，而无需在 `app.js` 中写包名特例。已有构建证据、但 Kconfig 无法表达的少量事实统一保存在根目录 `compatibility.json`；字段边界和维护规则见 [中文说明](docs/COMPATIBILITY.md) 与 [English](docs/COMPATIBILITY.en.md)。

## Schema 6 分片与体积报告

每个分支在迁移期同时发布旧单体和新分片：

- `*.core.json.gz`：Target/Profile、构建契约、来源与分片清单所需的最小启动数据。
- `*.graph.json.gz`：保留 `relations.schema=4`，供旧消费者使用；schema 3 仅为旧快照兼容。
- `*.graph.compact.json.gz`：index 的可选 `graphCompact`，使用 `relations.schema=5`、定义/表达式共享表与 positional edge rows。新消费者优先读取这一份图，不同时下载两份；声明存在但校验失败时必须报错，不能静默切换快照。
- `*.menu.json.gz`：可见 Advanced 菜单的英文标题、短说明与路径。
- `*.hidden.json.gz`：隐藏 Kconfig/packageinfo-only 的搜索显示信息。
- `*.help.json.gz`：长 Help/usage，仅在用户查看完整说明时下载。
- `*.menu.<lang>.json.gz`：当前语言的菜单译文，不再一次加载全部语言。
- `*.relations.json.gz`：同一 schema-4 紧凑关系图，供离线工具和诊断使用；不再发布 40+ MB 的缩进 JSON。
- `*.relations.debug.json.gz`：仅在 `CATALOG_DEBUG_RELATIONS=true` 时生成的可读对象版，不进入正常网页运行数据。

生成后的 `*.meta.json` 包含 `sizeReport`，记录旧单体、首次 `core + graph`、全部分片、可读 Relations 与紧凑 Relations 的字节数。汇总命令：

```bash
npm run size-report -- dist
```

紧凑格式只删除重复表示，不删除 `depends/select/imply/choice/conflicts/provides`、隐藏节点、packageinfo-only 语义或 virtual capability 身份。测试会分别展开 schema 4/5 并进行完整 typed round-trip；schema 3 仍可展开用于旧快照诊断。包元数据对齐上游 `metadata.pm`：同名实体采用最后定义，virtual provider 保留原生累计关系；原始 `Provides:` 与规范化 capability 分开，`@base-files-any` 不是 Kconfig 符号，多行 Description/Config 内容也不能生成假包。不同字段的条件、alternative、build-only 与 versioned token 不能混用解析规则。

### Compact graph measurement / 紧凑图测量

`scripts/benchmark-relation-wire-format.mjs` measures real graph data and requires full decoded structural equality. On one ImmortalWrt/master graph, schema 4 → 5 reduced raw JSON from 124,908,691 to 49,725,089 bytes and gzip-9 from 6,968,908 to 6,335,069 bytes. Median JSON parse time was 462.63 → 198.84 ms, with 82.41 ms additional schema-5 decoding; retained decoded heap was 236,123,376 → 140,630,456 bytes. These are representative local measurements, not a browser latency guarantee or a claim that every upstream configuration matches native `conf`.

该基准使用真实图，并要求解码后完整结构一致；上述单个分支测量不代表所有浏览器时延，也不等于所有配置已完成原生 `conf` 对照。原生元数据投影、typed relations 完整性、package closure 完整性与固件编译成功必须分别验证。

## 自动更新

`.github/workflows/catalog.yml` 每月按 include/exclude pattern 自动发现远程分支（UTC 每月 1 日 19:17，即 UTC+8 每月 2 日 03:17）；手动与数据输入变更触发保留。OpenWrt 覆盖 `main` 与 `openwrt-*`，ImmortalWrt 与 LEDE 覆盖 `master` 与 `openwrt-*`，未来版本无需人工加表；
hanwckf 仍只收录 `openwrt-21.02` 兼容分支。每个分支独立生成，
失败时沿用同一通道的上一次成功数据。`main` 发布到 `catalog-data`，`staging` 发布到
`catalog-staging`，`dev` 发布到 `catalog-dev`，`fix/*` 发布到 `catalog-fix`；每次先提交数据，
再用第二个提交把 `index.json` 的 `assetRef` 固定到前一个不可变数据提交。主站从 jsDelivr
或 GitHub Raw 整组读取 index 与该提交中的 gzip 分片，不在 VPS 保存 Catalog。

所有数据分支直接保存同名 `compatibility.json.gz`。只有 `main` 更新正式 Release；预览通道不创建 Release 或 Pages 地址。

- 矩阵不限制 `max-parallel`，由 GitHub 按账户并发额度调度。
- 自动翻译只新增软件包/菜单用途说明，技术名称与符号保持官方英文。脚本严格按 `index.json` 枚举旧单体和 schema 6 `menu:<lang>` 分片，并同步更新两者；不会扫描或改写 `core/graph/applications/compatibility`。简体中文说明未完成时，
  每日任务持续处理 `zh-CN`；完成后按 `ru → es → pt → ja → ko → de → fr → vi`
  每日轮转一种语言。英文是源文本，繁体中文暂时冻结，不进入自动轮转。
- 历史译文按“文本类型 + 英文正文”指纹复用；Push 触发只更新目录，不消耗翻译额度或推进
  轮转。默认每次最多请求 400,000 个源字符、每月最多记录 1,900,000 个字符；可通过
  Variables 的 `TRANSLATE_MONTHLY_BUDGET` 调整月预算，手动运行时也可调整单次预算和语言。
- 自动翻译默认使用无需密钥的本地 Argos。Azure 是可选引擎：使用时在仓库 Secrets 设置
  `AZURE_TRANSLATOR_KEY`，按资源需要设置 `AZURE_TRANSLATOR_REGION`，自定义端点可放在
  Variables 的 `AZURE_TRANSLATOR_ENDPOINT`。失败只写覆盖统计和错误，不阻断目录发布。
- Discover、每个矩阵 Job、Publish 依次使用 `01`、`02`… 编号；Job、
  Artifact、`SUMMARY`、attempt 和失败日志共用同一编号。Actions Summary
  另列一一对应表，按编号即可找到同一任务的全部资料。
- 每个分支独立校验 catalog、meta、translations、gzip 和 SHA-256；一个分支损坏只隔离该分支，不阻断其他成功分支发布。
- 成功阶段只输出名称和耗时；失败阶段在控制台显示关键错误及末尾 80 行，
  完整错误日志放入该分支唯一的结果 Artifact，保留 60 天。
- 本次失败或校验损坏但曾成功的分支沿用 `catalog-data` 中的 last-good 并标为
  `stale`；从未成功的分支标为 `unavailable`，不会伪装成最新数据。
- 正式生产不再复制一份 Catalog 到 GitHub Release。Production Gate 的唯一生产发布结果是
  `catalog-main`；其 `index.json` 通过 40 位 immutable `assetRef` 指向实际资产提交。
- Publish 会逐个读取下载后的 Artifact 目录，核对成功分支的 catalog、
  meta、translations、attempt、SUMMARY、gzip 和 SHA-256；无效的“成功”结果进入隔离诊断，
  不得覆盖旧数据。`publish-inputs.json` 会逐分支记录 fresh/last-good/unavailable。
  Publish 成败都会上传独立诊断 Artifact，记录输入清单、失败阶段和对应编号。

## Diagnostic identity and legacy metadata / 诊断身份与旧版元数据

Every matrix job and downloaded diagnostic file identifies its source, repository, branch,
display version, upstream commit, stage, run ID/attempt, job index, artifact and run URL.
Failure logs use unique names such as
`07-openwrt-openwrt-18.06--defconfig.log`; the same artifact also contains a readable
`--SUMMARY.txt` and a machine-readable `.attempt.json`. Full failure logs are retained for
60 days, while the Actions console shows only key errors and the last 40 relevant lines.

每个矩阵任务、错误日志和汇总文件都会写明源码、仓库、分支版本、上游提交、
失败阶段、Run ID/次数、任务序号、Artifact 名称和 Run 链接。日志文件名全局唯一，
不会再因多个分支都叫 `defconfig.log` 而互相覆盖；控制台只展示重点和末尾 80 行，完整错误日志保留 60 天。

Every Source/Branch uses one `metadata-only` boundary. Catalog extraction needs Kconfig/Perl
metadata but never compiles host tools or firmware, so it creates a fresh prerequisite cookie
before `make prepare-tmpinfo FORCE=1`. The rule is capability-based rather than a Source or
Branch allowlist, and therefore also covers future branches that retain obsolete Python/GCC
host checks.

所有 Source/Branch 统一使用 `metadata-only` 边界：Catalog 只提取 Kconfig/Perl
元数据，不编译主机工具或固件，因此在 `make prepare-tmpinfo FORCE=1` 前创建全新的
先决条件标记。该机制不按 Source/Branch 特判，也能自动覆盖仍保留旧 Python/GCC
主机检查的未来分支。

## 本地检查

```bash
npm test
```

真实目录生成需要 Linux 和 OpenWrt 构建依赖，由 GitHub Actions 完成：

```bash
node scripts/generate-catalog.mjs \
  --source-id OpenWrt \
  --repo openwrt/openwrt \
  --branch main \
  --tree /path/to/openwrt \
  --out dist
```

本项目保留上游英文原文，并维护 11 语菜单、常用插件用途、增量翻译缓存与覆盖报告；
未翻译或应保持原名的技术文本统一回退官方英文。

## Schema 6 runtime assets and the legacy build contract

During the migration window each branch publishes two independent contracts in `index.json`:

- `assets`: Schema 6 browser shards such as `core`, `graph`, and lazy menu/help assets;
- `legacy`: the exact Schema 5 / Relations 2 single bundle used by AutoBuild Actions validation.

The `legacy` object contains `asset`, compressed `hash`, compressed `bytes`, `catalogSchema`, and `relationsSchema`. Root-level `asset/hash/bytes` remain mirrored temporarily for older clients. New consumers must use `branch.legacy` as one atomic build contract and must not combine its file metadata with schemas from the split runtime model.

## Immutable asset manifests and channel publications

Asset-producing jobs (full generation, root-asset updates, and translations) remove
publication-only `assetRef`, `assetRefType`, and `provenance` before committing the
asset manifest. The following channel publication points to that immutable asset
commit and supplies code/channel provenance. An asset commit cannot embed its own
Git SHA. Reuse and production promotion preserve the same immutable assetRef and
verify that its manifest matches the published content, not just that the commit
exists. Legacy unstamped manifests remain readable; contradictory embedded asset
identities are rejected. Fix a malformed snapshot in a development source lane,
not by relaxing consumers or regenerating assets during production promotion.

## License / 许可证

This project is licensed under [GNU GPLv3 or later](LICENSE). The [Chinese explanation](LICENSE.zh-CN.md) is informational only. Copyright and the public contact address are in [NOTICE](NOTICE).

本项目以 [GNU GPLv3 或更高版本](LICENSE) 发布；[中文说明](LICENSE.zh-CN.md) 仅供参考。版权与公开联系方式见 [NOTICE](NOTICE)。
