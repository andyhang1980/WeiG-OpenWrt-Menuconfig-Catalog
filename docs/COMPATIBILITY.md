# Compatibility 证据规则

`compatibility.json` 只记录上游 Kconfig/Catalog 当前无法表达、但真实构建已经确认的兼容性事实。它不是第二套 dependency 数据库，不保存 symbol 类型、N/M/Y、名称、翻译、依赖、provider、包内容 hash 或生成时间。精确适用范围可引用已有源码/feeds 输入身份。

## Schema 7 与向后兼容发布

权威文档使用 schema 7。可选 `preferredDisable` 只指定规则命中后优先关闭的参与包，
不是依赖、锁定或可执行指令；共享 Kconfig planner 仍须模拟并验证合法修改，
不能因为包存在于 Catalog 就自动取消。

`all-installed` / `all-enabled` 必须所有参与包均存在且满足状态条件；
`packageAvailability: "if-present"` 在缺少任一参与包时跳过整条规则，不删除条件项。
首选参与包无法安全取消时，说明推荐不可用的原因，不自动转而取消另一参与包。
OWN-0002 只在 `autosamba` 与 `luci-app-samba4` 都安装时命中，优先取消 `autosamba`；
任一个单独存在，或仅编译为模块而不安装到 RootFS，都不满足此文件冲突条件。

根资产轻量发布按 index 合同收集所选资产族的全部版本文件，逐项验证 hash/bytes 后一起提交；不能只发布旧版投影。缺失或陈旧文件必须使发布失败，源码、生成合同和浏览器实际读取的字节必须一致。

schema 7 增加 `preservePackages`：只用于 all-installed 的普通参与包，
不能与 preferredDisable 重叠，不能用于 buildDependency。推荐模拟与实际应用均须保留
这些包的 Y；点击推荐才把保留值记为用户意图，不在导入时修改配置，也不禁止未来手动关闭。
index 向新消费者公布 `compatibility.v7.json.gz`，同时保留 v6 与 schema-5 投影。
要求保留约束或精确输入身份的新规则不能降级成旧消费者可能误用的推荐，故不进入旧投影；
旧规则、证据与配置读取继续兼容。
`inputHashes` 复用 Catalog 已有 source.inputsHash（规范化源码/feeds receipt 的 SHA-256），
仅用于已有 sourceCommits 的精确规则。缺少或不同身份只记录近似命中诊断，不套用旧规则；
Probe 使用同一 receipt 验证身份，Worker 不增加验证。改变 feeds 后需重新取证，不永久禁包。
预防策略适用于多个源，不代表这些源均已实测失败。

BLD-0010～BLD-0013 保存 iStoreOS/istoreos-24.10 与 Lienol/25.12 的 cjdns 编译故障，
同时覆盖同 Source-Makefile 的 cjdns-tests 输出。精确源码/feeds/目标与 GCC_VERSION 才适用，
消费者由原生图反向推导，不维护应用黑名单。完整身份、第一现场与同编译单元证据见
[cjdns 编译故障取证与推荐边界](COMPATIBILITY-CJDNS-20261006.md)。

OWN-0005 限定 Lienol/25.12、源码 a337df404ab3f6dc5b3e7b26a753343d3ad2f4c2、
x86/64/DEVICE_generic 与 Run 37270058783 的六个 feeds 证据：
luci-app-zerotier 1.0-r21 与 zerotier 1.16.0-r1 都安装 /etc/init.d/zerotier。
仅两者 Y 时推荐关闭界面，保留 zerotier=Y；仅后端或 M 不触发。
BLD-0008 保存同环境 verysync v2.13.2 非 gzip 下载证据（37270201344），
BLD-0009 保存 iStoreOS/istoreos-24.10 源码 fb971407ffd9a094e6f16d9c029f1f580ed5c2ad
的 vlmcsd 1113 错误 tag URL 证据（37277262603）。三条新规则同时匹配精确源码、feeds 输入身份与目标；
原生图推导反向取消，不写 triggerPackages，不改上游下载或 Worker。

Catalog metadata-only 阶段在支持的原生 Dumpinfo/Package 中添加命名输出字段，
由 GNU Make 展开 EXTRA_DEPENDS。安装依赖单独保存在 installation.runtime，不伪造
Kconfig select、不改变原生 defconfig baseline；OPKG/APK 的 Y 安装检查共用该事实。
未知版本约束或新方言保留待定。旧数据没有新事实，不能宣称已经覆盖安装依赖。

OWN-0003 在 `luci-app-pppoe-server` 与 `rp-pppoe-server` 均安装时优先取消后者；预防范围为 LEDE、ImmortalWrt、hanwckf 各分支中两包均存在的环境。`luci-app-rp-pppoe-server` 是另一应用，它为 N 不代表前者为 N。共享 planner 可以先取消真实选择者以达到首选目标 N，等价动作去重保留所有 `resolvedPackages`。

BLD-0006 使用经批准的 `preventive` 策略：范围限定 LEDE/master、x86/64、`LINUX_6_18` 且失败包存在，源码提交变化不再自动绕过预防。`evidence` 分别保存源码 `6248ca158b90d640ece2c1a56c392cb0c430b665` 与 `bfec801a42f344bb7566d1f4f8960fb0cdb08350` 的精确 feeds 和失败引用；两次都是 Linux 6.18.54、OpenAppFilter `a9e4637b5806b62f0e98fa6273384f849e93ae9a` 调用缺失的 `del_timer_sync`。`appfilter` 与内核包共用 Source-Makefile，不能只关闭一个输出而留下同源活动编译入口；触发者由图动态推导。其它源、目标或内核不外推；此策略不具备包版本自动失效能力，上游修复后须验证并缩小或撤销范围。退休的 BLD-0004 不复用。

## Schema 5

### 本次精确取证（Lienol/25.12）

OWN-0004 仅覆盖源码 `a337df404ab3f6dc5b3e7b26a753343d3ad2f4c2`、x86/64、DEVICE_generic：Run 37233040067 的原生包元数据与安装日志确认 `softethervpn-base` 4.38-r3 和 `softethervpn5-libs` 5.2.5188-r1 重复安装五条路径。已完整阅读 packages feed `fad5bd22ef3f137cad2add7904ac441291244a49` 的 `net/softethervpn/Makefile` 与 `net/softethervpn5/Makefile` 安装定义。只有两包均为 Y 才命中，不推断用户偏好的版本；通用 planner 反向处理实际选择者，等价方案由用户选择。

BLD-0007 采用相同精确环境边界：Run 37232152405 的 QtBase 5.15.8 在应用 `010-gcc11.patch` 时失败，尚未进入软件包编译。失败目标记录为原生 qtbase Source-Makefile 的 concrete 输出 `qt5-core`，不是把所有 qBittorrent 版本列为故障。对锁定 lienol feed `eb8b7938c0e91065e2d60adcc2e8b6fd2f796261` 的全部 Makefile 扫描并完整阅读 QtBase、QtTools、动态 qBittorrent 和 LuCI 入口：动态分支依赖 Qt5，静态分支不走 QtBase；QtTools 的 Build-Depends 也进入同一源码。结合该 Run 完整原生 `.packageinfo` / `.packagedeps` 审核其余已安装 feeds 的活动路径。反向触发者仍由图生成，没有维护应用黑名单。

两条规则的 refs 保存该环境全部六个 feeds 提交。源码提交或 Target 改变后不外推；refs 是取证身份，不宣称兼容规则已有独立 feeds 匹配字段。verysync 下载得到非归档内容属于上游下载问题，不建立禁包规则。固件 Worker 不消费兼容规则审查配置，离线诊断与 Probe 的证据验证职责保持独立。

读取端继续兼容 schema 2、3、4 和 5。文档仍只有 `schema` 和 `rules`。schema 4 增加的 `sourceCommits`、`targetScope`、`failure` 和 `buildDependency` 继续保持原义；schema 5 另外允许经明确审核的全局预防规则：

- `policy: "preventive"`：声明规则的适用范围是预防策略，不把单个环境的构建证据外推成所有上游都已实测失败。
- `environments`：定义预防策略适用的 Source/Branch/Target 范围。`source` 与 `branch` 可使用 `*`；`packageAvailability: "if-present"` 表示失败目标不存在时整条规则“不适用”，不得报错。
- `evidence`：保存真实观察到故障的精确 Source、Branch、40 位源码提交、Target 范围和短引用。证据边界与策略适用范围严格分离。

schema 4 在原规则上增加：

- `sourceCommits`：可选完整 40 位源码提交列表，使临时上游故障在源码前进后自动失效。
- `targetScope`：可选 Target `system`/`subtarget`/`profile` 精确范围；省略时覆盖该 Source/Branch 中所有真实包含目标包的环境。
- `failure`：`build-failure` 必需的结构化证据，包含 `phase`、`cause`、稳定 `code` 与可选 `observed`；只负责说明，不驱动依赖或改写配置。
- `buildDependency`：`build-failure` 可选的失败目标事实，只要求一个真实 concrete `package`。旧规则中的 `triggerPackages` 仍可读取，但不再要求、维护或作为第二套依赖数据库；直接入口必须由当前精确 Source/Branch/commit 的 typed relations 图动态反向/正向验证。它不能出现在 `file-ownership` 规则中。

schema 2 旧规则继续按以下字段读取：

- `id`：稳定 ID；文件归属使用 `OWN-xxxx`，已知构建失败使用 `BLD-xxxx`。
- `issue`：`file-ownership` 或 `build-failure`。
- `match`：`all-installed` 表示所有包必须为 Y；`all-selected` 表示所有包为 M/Y。
- `scope`：Source 到 Branch pattern 数组的映射。Source 可为具体 ID，或单独使用 `*`；Branch 支持精确值和 glob。`*` Source 不得与具体 Source 混用。
- `if`：可选 Kconfig 条件；不得复制已有依赖。
- `packages`：1–16 个真实 package ID。单包已知失败直接使用一个 ID，不伪造冲突方。
- `paths`：仅 `file-ownership` 必需，保存已确认重复归属的绝对路径。
- `refs`：1–8 个短证据引用，例如 `run:31319173318`，不复制完整日志。

网页执行链唯一为：

```text
evaluateCompatibilityRules → deriveCompatibilityPlans → applyUserIntent
```

规则不得包含命令、补丁或专用执行逻辑。构建端不得据此锁包或改写用户配置。浏览器可以把 `buildDependency` 作为证据交给通用推荐规划器，规划器仍只通过现有 Kconfig relations 和 `applyUserIntent()` 生成最少合法操作。用户可应用推荐方案、自定义 N/M/Y，或二次确认后强制继续。

对于带 `buildDependency` 的规则，消费方以失败的 concrete `buildDependency.package` 为图搜索目标，从当前配置反向寻找 direct concrete roots，再正向验证每条条件路径确实可达。旧 `triggerPackages` 只作为历史证据展示，不能扩大参与集合、触发取消或替代当前图。条件、alternative、select/imply 或 virtual provider 无法证明时返回 `inconclusive`；不能按包名、Source 或 Branch 猜测。

每份 relations 资产必须声明 `relationsComplete` 与字段能力。缺失或为 `false` 时，网页和 Probe 只能延后/返回 `inconclusive`，不得把不完整关系当作兼容结论。

### 原生 Kconfig 解析与 source-closure 证明

真实软件包身份必须来自原生包元数据；`PACKAGE_` 前缀也可能属于配置子选项，不能据此生成构建包实体。可读图与紧凑图保留同一身份区分。Choice 详情通过 `memberOrder: "native-declaration-v1"` 保留原生声明顺序，并在 Target 投影删去成员记录时仍保留完整成员列表。消费者不能用字母排序替代，也不能把缺失成员猜成关闭。Linux 原生 `conf` 样例验证 choice 顺序回退、条件 scalar/select 收敛、显式值保留和非活动 owner；这些检查验证契约，不宣称所有历史配置或上游固件构建都已验证。

Catalog 复用上游 Kconfig 的词法边界：bool default 的 `m` 可以作为原始三态字面量保留，注释只在引号外剥离；引号外的 `@` 记录为 ignored-character warning 后继续解析普通表达式 AST，`@` 后面的 Kconfig symbols 仍保留，不能包装成另一种 package-selector AST；引号内的 `@` 不产生警告。`.packageinfo` 的 `@(...)` 仍由独立的软件包元数据解析器处理，不能混用这两个域。

符号缺失只有在没有未求值动态预处理、且完整 active source closure 已被证明时才能分类为 native undefined。明确被 Target projection 排除的真实定义，只有同时有完整 parser proof 和 `parsed-target-filter` provenance 时才可作为 external；如果已解析定义既没有进入 graph、也没有这份证明，则仍是 projection omission，必须保持 `unresolved`。native undefined 的记录保留实际缺失符号、`nativeType: "unknown"`、bool coercion `n` 和原始 string token；不得把所有 unresolved 或所有带 source 标签的名称直接当成 external。`externalSymbolDefinitions` 只允许输出真实解析定义的 `{symbol,type}`。任何未求值的 `$(shell,...)` 或动态赋值都会使 `relationsComplete=false`，此时相关缺失只能保持 `unresolved`/`inconclusive`。

软件包构建闭包是独立的窄能力，不依赖完整 typed Kconfig：relations 另行声明
`packageClosureComplete`、`packageClosureCapabilities` 和
`packageClosureValidation`。只有精确刷新得到的 `.packageinfo` 依赖 token（包含
alternative/condition）、virtual provider，以及已经校验过的 package 正向/反向边都完整时，
才声明 `complete-package-build-closure-v1`。该能力足够让 `buildDependency.package` 从失败
concrete package 做通用闭包证明；它绝不能把 `relationsComplete` 置为 true。defaults、depends、
select、imply、visibility、choice、MODULES 等确定性 Kconfig 判断仍必须要求完整
`relationsComplete`，否则只能 `inconclusive`。

schema 4 紧凑契约：`records[*]` 按公开的 `fields` 顺序解释；各池无损保存 typed 有序 defaults/ranges、原始与 AST 表达式、direct/inherited 可见性和依赖 variants、逐定义 `nodes`、分离的 `packageConflicts`/`kconfigConflicts` 与包 capability relations。本轮修复的多定义 depends/visibility AST aggregate 只代表首个定义，完整定义继续保存在有序 variants；select/imply 仍按既有关系语义聚合。`indexes` 包含 `byPackage`、`bySymbol`、`providers`、`reverseDependencies`、`reverseKconfig`、`reverseSelects`、`reverseImplies`、`forwardEdges`、`reverseEdges`。每条 edge 保留 `expressionAst`、`conditionAst`、嵌套 `alternatives`、provider ownership，并明确用 `required: null` 表示候选/未知边；edge rows 按源 ID 保持 positional，不能因内容相同而去重。`defaultsFields` 同时保留解析值、条件和原始 default 拼写。求值器必须以有序 definition records 为权威输入，展平字段只用于兼容投影；compact-expand 语义 mismatch 必须产生有界结构差异诊断，不能静默通过。

普通临时故障规则仍以 `sourceCommits` 为失效边界，且 `buildDependency` 只能用于完整精确提交边界。经明确批准的 schema-5 `preventive` 规则改用 `evidence` 保存精确事实，并用 `environments` 独立控制预防范围。`packageAvailability: "if-present"` 下，失败目标不存在即跳过；规则只有在有效配置选择当前 Catalog 中真实存在的失败目标，且图证明当前活动用户根可达该失败目标时才触发。图路径未知时保持 `inconclusive`，不得恢复静态 trigger 参与集合。RootFS 容量、Runner、网络和磁盘问题不得写入本文件。

规范化 JSON 未压缩上限 512 KiB。只有接近上限时才通过明确 schema 迁移按 Source/Branch 拆分；禁止提前维护平行数据集。

## 已登记规则

### OWN-0001

- 范围：ImmortalWrt `openwrt-25.12`，且 `USE_APK` 成立。
- 触发：`luci-app-openvpn-server=Y` 与 `openvpn-openssl=Y`。
- 问题：两包同时拥有 `/etc/config/openvpn`，APK 安装阶段发生文件归属冲突。
- 证据：Run `31248199953`、`31382153641`；两次均为 `trying to overwrite etc/config/openvpn owned by openvpn-openssl`。
- 处理：Catalog 通用 intent 比较关闭任一参与包的级联成本；只有唯一最低成本方案才推荐。用户仍可强制继续。
- 删除条件：上游消除重复归属并通过真实构建后，立即缩小 scope 或删规则。

### BLD-0001

- 范围：ImmortalWrt 全部 Branch 与 LEDE 全部 Branch，即 `ImmortalWrt:["*"]`、`lede:["*"]`。
- 触发：`oscam=M/Y`。
- 问题：多轮真实构建均在链接阶段缺失 `_binary_SoftCam_Key_start/end`；当前 Kconfig 没有能独立关闭该内部功能的 symbol。
- 证据：Run `31319173318`、`31343335898`、`31343364994`、`31343384324`、`31343420988`。
- 处理：推荐方案只通过 `applyUserIntent()` 把 `oscam` 调整为 N。强制继续不会修复源码，构建仍可能失败。
- 删除条件：任一上游范围修复后先用包级探测和真实构建确认，再缩小 scope；全部修复后删除。

### BLD-0002

- 范围：ImmortalWrt `master`。
- 触发：`luci-app-openvpn-server=M/Y`。
- 问题：该 Branch 当前由 `ovpn-dco` 在 Linux 6.18 的 `tcp.c` 编译失败；这是单包依赖闭包的源码构建失败，不是 `/etc/config/openvpn` 文件归属冲突。
- 证据：Run `31382119111`。
- 处理：推荐方案只通过通用 `applyUserIntent()` 把该包调整为 N；强制继续不会修补上游源码。
- 删除条件：上游修复并经包级探测与真实构建确认后删除。

### BLD-0003

- 策略范围：所有 Source、所有 Branch、所有 Target/Profile，但仅在当前 Catalog 真实提供 `dockerd` 时适用；没有 `dockerd` 的环境直接跳过。
- 失败目标：`dockerd`。直接入口不在规则中维护；由当前 Source/Branch/commit 的 typed package/Kconfig/Make relations 动态计算。没有可证明路径时不产生取消建议。
- 问题：Moby 29.6.1 在复制嵌套可执行文件时把空的 `command -v` 结果传给 `cp`。
- 精确证据：ImmortalWrt `openwrt-25.12` 提交 `6081813a…` 的 Runs `33091565296`、`32703315265`、`32702715228`、`32719724510`、`33229690268`、`33230123378`，以及提交 `1d34e7b…` 的 Run `33293241107`。这些证据不表示其他 Source/Branch 已实测失败。
- 删除条件：只有明确撤销该全局预防策略时才缩小或删除 `environments`；真实证据仍按精确环境维护，不能因策略范围扩大而伪造。

### BLD-0005

- 范围：LEDE `master` 的精确源码提交 `bb287c19…`，不限制 Target/Profile。
- 触发：`luci-app-passwall=M/Y`。
- 问题：rootfs 安装阶段缺少 `ipt2socks`、`shadowsocks-rust-*`、`simple-obfs-client`、`v2ray-plugin` 等配套 feed 包。
- 证据：Run `32929550697`。
- 删除条件：匹配的 Passwall LuCI/packages feeds 完成构建验证后删除。

## 维护、探测与发布

新增规则前先查上游源码和真实证据；确认一个范围后横向检查同 Source/Branch 机制。Source/Branch 新版本若已被 glob 覆盖，无需增加 JSON 项，但首次真实探测仍应记录证据。上游修复后及时删减，禁止 zombie rule。

### 探针深度边界

Catalog 的 **Package Compatibility Probe / 软件包兼容探针** 使用 Probe V3 协议，并把“请求事实”和“环境解析”分给各自权威：Issue 只携带用户直接 `packageIntent` 及其紧凑的变更前/后 `PACKAGE_*` 投影；Catalog core 提供每个环境的 Target/Profile 选择器；克隆真实上游源码后，该 Source 自己的 Kconfig/Defconfig 补齐依赖并负责后续构建顺序、stamp 与增量构建。

- **L1 插件（`config-resolve`）**：默认使用当前源码官方 Kconfig/Defconfig 求解 Final Root 组合；手动工作流默认勾选可选 A/B（显式关闭仍保留 Final-only），开启后先在 Feeds 安装完成后强制刷新当前 Source/Branch 元数据，再做插件 Root 预检，然后求解排除所选插件的 Baseline B，最后求解 Final A，逐环境保留一条配对证据，只证明配置能否成立，不执行软件包编译。若直接 Root 不在该源码/分支，预检记为 `skipped/root-absent-source`，B 与 A 均为 `not-run`，不会进入 Target 或编译阶段。
- **L2 编译（`package-compile`）**：把用户直接启用的软件包当作 Root，读取上游 `tmp/.packageinfo` 的 `Source-Makefile`，把 Binary Package 映射为真实源码目标；共用 Source 的 Root 自动去重，并用一次 Make 调用进入上游依赖图。WeiG 不维护第二份 Binary→Source 或 dependency 数据库。
- **L3 根系统（`rootfs-integration`）**：复用同一次 L2 结果，再按上游顺序完成 `prepare`、完整已选 `package/compile` 与 `package/install`。Target、基础包及内核版本等 RootFS 前置事实全部由当前 Source 的 Make 图生成，WeiG 不自行拼装 APK/OPKG。
- **L4 集成（`firmware-integration`）**：默认只使用用户最终配置完成一次整机固件构建；开启可选 `comparison: { mode: "paired-exclusion", executionOrder: ["baseline", "final"] }` 后，同一环境 Job 先以排除所选直接插件以及经 Defconfig 判定不再需要的自动依赖后的 Baseline B 完成对应层级，再以最终配置的 Final A 重新完成固件、启动与运行阶段。
- **L5 启动（`boot-smoke`）**：L4 成功后优先调用当前源码自己的 `scripts/qemustart`，确认 Final 固件进入基本用户空间；不维护 Target/QEMU 参数表。
- **L6 运行（`runtime-health`）**：在 L5 后通过可靠控制通道检查 init/procd、基础挂载、uptime、可用时的 ubus，以及 Final 中真正内置的 Root 软件包。需要按键激活串口时，先激活并等到 root prompt，再发送健康命令；无可靠控制能力时记为 `skipped`。
- **L7 重启（`reboot-validation`）**：在 L6 后正常重启 Final 固件，等待第二次启动并再次执行相同健康检查；不执行真实 sysupgrade 刷写。
- **L5–L7 固件与虚拟启动适配**：固件完成后只扫描实际的 `bin/targets/<target>/<subtarget>/` 产物，不依赖 `openwrt-*` 品牌前缀。只有文件名明确表达 rootfs-only 语义的产物才能传给 `scripts/qemustart --rootfs`；combined/combined-efi、factory、sysupgrade 与厂商 `.bin` 只作为库存证据，不能被当作裸 RootFS。`.gz` 产物通过有界流式解压到 Probe 自有临时目录；仅当当前源码的 `scripts/qemustart` 真实解析器明确支持官方 `--rootfs`/`--kernel` 参数并存在安全 RootFS 时，才把真实路径传入，注释和 usage 文本不构成能力。只有 combined 等不可安全消费的产物，或没有安全消费路径时，才记为 `skipped/virtual-boot-unsupported`，并保留 `deepestPassedLevel=L4`；Baseline-B Guest 的确定性启动失败记为 `blocked/base-profile-boot-failure`，Final-A Guest 的确定性启动失败记为 `incompatible/final-boot-failed`；QEMU、权限或宿主资源错误记为 `unresolved`。阶段语义确保插件导致的 Final-A 启动失败不会被误报为上游 Base Profile 阻断。

L2–L7 默认逐级复用已经完成的 Stage，不为增加深度而重复构建；开启 A/B 后，B→A 仍共享同一 Job 的 bootstrap、源码、feeds 与增量 Make 工作树，但每个 phase 拥有独立日志和证据。所有 A/B 深度在 B 前都必须在 Feeds 安装完成后强制重新生成当前 Source/Branch 的 `tmp/.packageinfo`，即使该文件已经存在也不得复用旧缓存；刷新失败或刷新后文件缺失统一记为 `metadata-unresolved/inconclusive` 并保持 Job 失败。预检随后只解析刷新后的元数据，不以空 Root 进入 Target/RootFS/固件构建。若 Root 缺失，统一为 `preflight-skipped`，B 与 A 均为 `not-run`，Summary 不显示 “Baseline B failed”。Baseline B 没有直接 Root 时记为 `baseline-ready/no-direct-roots`，不编译插件，也不宣称已完成所有基础软件包；B 的 `prepare` 或共享基础目标失败时短路 A，若证据确认是 Base Profile/上游问题则记为 `blocked`，插件为 `not-evaluated`，不得归因插件。若 B 只因 L5–L7 虚拟启动能力缺失而 `skipped/virtual-boot-unsupported`，Final A 仍至少完成 L4，配对结果必须报告“固件构建通过、运行时未覆盖”，不得把 B 的能力缺失扩大成 Base Profile 阻断。只有 B 成功且 A 失败，或 B 的隔离反事实重放成功而 A 失败时，才可归因插件；L3–L7 的 A 会重新调用对应的 install/image/qemu 阶段。所有深度都强制运行所选 Source 自己的官方解析器：L1 使用 `scripts/config/conf`，L2–L7 使用 `make defconfig`。用户不能关闭该步骤；只有直接 Probe Root 必须保持请求的 `m/y` 状态，`libatomic`、`libusb-1.0` 等自动依赖只出现在各环境解析后的配置和证据中，不进入 Issue 请求。

Probe V3 的浏览器状态包含直接 `packageIntent`、由该 Intent 派生的紧凑 `baselinePackageConfig`/`packageConfig`、固定启用的 Defconfig、五维环境约束和覆盖策略。网页中 Advanced menuconfig 的完整 836 项或 Defconfig 后的 276 项只是交互状态，不是探针请求；Runner 不接收 dependency list、build order 或第二个 packages/roots 权威。服务端先校验请求，再对所有 L1–L7 统一重新派生紧凑 Root 配置，因此旧客户端夹带的自动依赖也不会进入执行权威。旧 `WEIG_PACKAGE_PROBE_STATE_V2` 请求明确拒绝。

每个 Probe Job 先克隆 Catalog 固定的上游提交，再从该源码的 `include/prereq-build.mk` 检测 Python 与 GCC 能力；不得根据 Source/Branch 名字选择运行环境。Runner 的通用构建依赖一次性覆盖后续软件包、RootFS 与固件阶段，需要兼容版本时只安装检测结果要求的运行环境；随后通过上游 `make prepare-mk` 校验不依赖 Target/Profile `.config` 的主机前置条件。证据分别记录直接 Root 数、Defconfig 解析后的软件包数、Python 与编译器身份。

环境范围由 Catalog 的真实结构动态解析，五个维度均可独立使用通配或精确值：**Source / Branch / Target System / Subtarget / Target Profile**。Target System、Subtarget 与 Profile 直接读取 Catalog core 已有的结构化字段，不从 `x86/64` 之类字符串反向猜测。通配保存的是规则而不是当前叶子快照，因此以后自动发现的新 Branch/Target/Profile 会自然进入匹配范围；不存在的组合记为不适用，不记为不兼容。

覆盖有两种模式。**Auto** 在管理员预算内做可复现的分层最大覆盖：候选不超过预算时全部执行，超过预算时只在未被用户固定的维度上优先覆盖不同 Source、Branch、Target System、Subtarget 和 Profile；抽样 seed 进入证据，新 Run 可以轮换样本。默认预算由 `.github/automation-policy.json` 管理：L1=40、L2=200、L3=100、L4=30、L5=10，单批不超过 256；L6/L7 在完成真实耗时测量前必须明确填写上限。**全部遍历**覆盖所有真实候选；超过 256 时固定同一 Catalog data commit 与 sampling seed，按最多 256 个环境顺序续批，不一次制造数千个并发 Job。

抽样与全量结论严格分开：样本全部成功/失败只能记为 `sampled-compatible` / `sampled-incompatible`；完整覆盖后才允许 `fully-compatible` / `fully-incompatible`；同一范围内成功与失败并存为 `partially-compatible`。每个环境的 `compatible`、`incompatible`、`blocked`、`skipped` 都是完整领域结论；其中 `blocked` 表示已确认 Base Profile/上游共享环境错误，插件未评价，不计入插件不兼容率。Summary 单独统计插件不兼容、Base Profile blocked 和执行 `unresolved`。下载、磁盘、Runner、metadata 解析、取消与超时等基础设施问题保持 `unresolved/inconclusive`，证据不完整时 Job 失败。结果按 Source → Branch → Target System → Subtarget → Target Profile 聚合，因此可把问题收缩到具体源码、分支或目标范围，但证据不会自动宣称是某上游 Bug，也不会自动改写 `compatibility.json`。
Summary 的成功率统一为 `compatible / (compatible + incompatible + blocked + inconclusive)`，`skipped` 不进入分母；已评价兼容率为 `compatible / (compatible + incompatible)`，插件评价覆盖率为 `(compatible + incompatible) / applicable`，插件主因率为已确认插件主因的不兼容数除以 `incompatible`。Notes 必须为全兼容、全不兼容、blocked、skipped、回放不可用/未定、unresolved 及 L4 通过但 L5–L7 未覆盖的环境提供明确说明。

运行状态与兼容性结论是两个轴：`target-prerequisite-failure`、`package-compile-prerequisite-failure`、`rootfs-*-prerequisite-failure` 与 `firmware-prerequisite-failure` 先保留最内层 failed target、通用 cause、failure fingerprint 和确定性 error summary，例如 `package/kernel/linux`、`kernel-prerequisite`、`module .../crypto/geniv.ko is missing`。若失败目标属于 B/A 共享基础目标，则在隔离的 Baseline B 环境中重放：B 也失败记为 `blocked`，B 成功而 A 失败才记为插件引起的 `incompatible`；直接 Root 或 A 新增依赖失败分别记为插件直接/依赖不兼容。回放分为 `replay-bootstrap`、`replay-prepare`、`replay-target` 三个阶段；已识别且证据完整、但尚未进入共享 Target 的回放能力缺口记为结构化 `counterfactual-replay-unavailable/inconclusive`，单环境 Job 可绿色但不计为兼容；未知失败、证据缺失或 Runner 崩溃仍为 `counterfactual-unresolved` 并保持红色。Baseline B 的 `blocked` 会明确写出 Final A `not-run`，不计入插件主因率。Feeds 后元数据刷新失败必须记录为结构化 `metadata-unresolved` issue（`phase: preflight`），Summary Notes 明确写出“Feeds 后元数据刷新失败”；它不是插件缺失跳过，也不是可报告的绿色结论。网络、下载、磁盘、OOM/Killed、Runner、timeout、metadata/evidence 缺失，以及没有确定证据的 unattributed failure，都是 operational/unattributed `unresolved/inconclusive`，必须保持红色。最终兼容性结论只读取 normalized evidence，不以 Job 的绿色或红色替代证据结论。
旧版 `reported inconclusive` 前置失败词汇仅为兼容旧证据而保留；新识别的确定性 Base Profile 错误输出为 `blocked`，而 operational/unattributed inconclusive 仍归为 `unresolved` 并保持红色。

Issue 网关仍以真实 Issue 作者和仓库权限作为权限事实，校验 V3 state token、SHA-256 与 Issue 身份后派发相同代码通道；后续批次继续固定第一次解析的 Catalog data commit。仓库 owner/admin 可使用管理员并发预算，write/maintain 协作者仍受 3 并发上限；普通访客不能启动 Matrix。请求者或具有 write/maintain/admin 权限的协作者可在同一 Issue 回复精确 `/cancel`，取消标记会同时停止当前 Run 并阻止后续批次。规范化证据保留 60 天，完整日志保留 30 天。

失败后的诊断遵循上游增量构建：耗时目标先按 Runner 可用 CPU 数加一执行；失败后对**同一批上游 Root targets**以 `-j1 V=s BUILD_LOG=1` 串行复核，复用同一工作树和 stamp。旧的“Final PACKAGE 全量逐包 compile”、fallback Target 循环和 `reduceFailureSet()`/`reductionMaxAttempts` 已不再属于 Probe 架构，Runner 不自行拆 dependency closure 或搜索最小失败集合。

代码 `main` 与正式数据 `catalog-data` 仍是独立生命周期：Builder `main` 只写 `catalog-candidate`，运行时/探针 `main` 读取 `catalog-data`；生产数据只能经手动 Production Gate 晋级。普通 Push、schedule 和 Probe 实验不能旁路 Production Gate。

GitHub Hosted Runner 仍受平台 Job 时限约束；各 Probe 深度的 timeout 由 `.github/automation-policy.json` 统一声明。达到超时只得到 `inconclusive`，不得当作软件包失败证据。

新增插件或规则前的硬顺序是：复用现有 Catalog 数据 → 横向审计同数据类型、执行路径和风险类别 → 先运行包级探针 → 再以真实证据维护通用规则。AutoBuild 不得写插件名或专用执行器。

仅 `compatibility.json` 变化时，Workflow 以稀疏 checkout 读取 `index.json` 和 `compatibility.json.gz`，调用 `build-index.mjs --compatibility-only`，不重跑 Source/Branch 矩阵。仅 `curated-sizes.json` 变化时同理调用 `--applications-only` 更新 `applications.json.gz`。生成器、Source 策略或 Workflow 变化仍运行完整矩阵。

中文与英文规则说明必须同步维护。English: [COMPATIBILITY.en.md](COMPATIBILITY.en.md)
