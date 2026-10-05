# cjdns 编译故障取证与推荐边界

## 原始失败

| 环境 | 精确构建证据 | 第一处软件包编译错误 | 规则 |
| --- | --- | --- | --- |
| iStoreOS / istoreos-24.10，x86/64/DEVICE_generic，OPKG | [Run 37320004199 / Job 111796478175](https://github.com/weigefenxiang/WeiG-OpenWrt-AutoBuild/actions/runs/37320004199/job/111796478175)，Issue #578 | cjdns 21.1-r6 的 libuv/GYP 选择 Python 3.11.14，调用 `collections.MutableSet` 失败 | BLD-0010；同源码测试输出 BLD-0012 |
| Lienol / 25.12，x86/64/DEVICE_generic，APK | [Run 37320749444 / Job 111798979743](https://github.com/weigefenxiang/WeiG-OpenWrt-AutoBuild/actions/runs/37320749444/job/111798979743)，Issue #580 | cjdns 21.1-r7 向 GCC 13.4.0 传入不支持的 `-Wno-error=calloc-transposed-args`，RandomBytes.js 编译探测失败 | BLD-0011；同源码测试输出 BLD-0013 |

两份请求的 Catalog Data 都是 `77bef2fd0834a2c06f83ba7179a8f778027f6472`，Worker 代码为
`c98f08455e98ab609616e7a0da03216108dfb0e7`。RootFS 512 是显式配置。
请求覆盖值验证的 mismatch 为 0；重建配置与最终配置逐符号比较无差异。
两次均没有执行 defconfig。因此第一处编译错误不是网页错选或 Worker 改写配置导致。

iStoreOS 的补丁先尝试 `six.moves.collections_abc`，失败后回退到 `collections`。
Python 3.11.14 与失败 API 有直接日志证据；兼容导入失败后进入回退是从补丁控制流推导的解释，
不是另一次运行时取证。不把后续缺少 `libuv.a` 当作独立安装依赖问题，不猜测安装系统 Python 的 six 即可修复。
该请求没有选中 python3-base；固件包选择不能替代上游 host Python 的证据。

Lienol 的单线程诊断重试出现 `ENOENT scandir './admin'`，属于已经失败后的第二现场；
规则记录并行编译第一现场的编译器选项错误，不把诊断重试误当原始根因。

## 源码和 feeds 身份

| 身份 | iStoreOS | Lienol |
| --- | --- | --- |
| 源码仓库 | istoreos/istoreos | Lienol/openwrt |
| 源码提交 | fb971407ffd9a094e6f16d9c029f1f580ed5c2ad | a337df404ab3f6dc5b3e7b26a753343d3ad2f4c2 |
| inputsHash | 750cca36b6786ae99dd924ca03867f49e04982bd5264cc09a19d5775783543f5 | 9bc5eaee6bddea372f948fa70279c711f1757dbe6508ec5f09eb8817715ad074 |
| 原生 package-info SHA-256 | 4523845b44d44d2f6d7486c6bf39102195527e647de11b702b58c558c164198d | 0129d5e665a86187833d0774c6f5a962cc815aeb90e1c9e54468da19248e7356 |
| cjdns Makefile SHA-256 | 5427d95108aa5d7b89eaa17b5ef7e9bdf18478ba29641da83f97628e4f109708 | 8ba53d00235c5d43f56caef4a752d57d5c35b75653156a5b1119ef78d0369576 |
| 基线及最终 GCC_VERSION | 13.3.0 | 13.4.0 |

完整 feeds receipt：

| 环境 | Feed / 仓库 | 精确提交 | 扫描 Makefile 数 |
| --- | --- | --- | ---: |
| iStoreOS | packages / jjm2473/packages | f1c73e13fc8c78f5f1c74096f25494817494dc47 | 1469 |
| iStoreOS | luci / jjm2473/luci | b28d7f1da49c3cb4ce931aff3267473fb327a05b | 195 |
| iStoreOS | routing / openwrt/routing | 00619bc7bc60d8b67ecc490121e45298b122cd6e | 29 |
| iStoreOS | telephony / openwrt/telephony | 92892fa285360b8981f62bf4e0a097e6449e7e33 | 38 |
| iStoreOS | store / linkease/istore | a97ace34f2da358a015b094d326bba2697697f2e | 6 |
| iStoreOS | third / jjm2473/openwrt-third | 335fa421e0fcd673a78986117981d4dfa3bf57d7 | 9 |
| Lienol | lienol / Lienol/openwrt-package | eb8b7938c0e91065e2d60adcc2e8b6fd2f796261 | 81 |
| Lienol | packages / Lienol/openwrt-packages | fad5bd22ef3f137cad2add7904ac441291244a49 | 1453 |
| Lienol | luci / Lienol/openwrt-luci | 6998d0bd430ef7d1acca0e8f83cfc46221235e11 | 177 |
| Lienol | routing / openwrt/routing | b32747dca62435f1ea01b7a5320c3da15eead46f | 22 |
| Lienol | telephony / openwrt/telephony | 2618106d5846a4a542fdf5809f0d3ed228ce439b | 38 |
| Lienol | video / Lienol/openwrt-video | 094bf58da6682f895255a35a84349a79dab4bf95 | 49 |

另外扫描 iStoreOS 源码 562 个、Lienol 源码 671 个 Makefile；总计 4,799 个。
只有 routing 的 cjdns 配方和 luci-app-cjdns 配方引用故障包，未发现其他名称触发者。
结合两次原生 `.packageinfo`、`.packagedeps` 和完整相关配方审核，直接运行依赖消费者均只有
`luci-app-cjdns`，其 `DEPENDS:=+cjdns +luci-compat +luci-base`。
两个前端 Makefile 的 SHA-256 同为
`16734a5f3587e20d5c92f7b03fc66a34c7de6ab674bea364ffec958756bb4554`。

## 同源码输出与推荐行为

`cjdns` 和 `cjdns-tests` 的原生 Source-Makefile 均为
`package/feeds/routing/cjdns/Makefile`，共用无条件的 Build/Compile。
使用已有 GNU Make 图求值工具消费两次 Run 保存的 `.packagedeps`：
原始配置及仅启用 cjdns-tests 的 M/Y 图投影，均可到达
`package/feeds/routing/cjdns/compile`。
因此 tests 输出记录的是同编译单元等价证据，不冒充另一次独立探针失败或成功固件构建。

规则只保存真实 concrete 包及 buildDependency，不增加手写 triggerPackages 或第二套依赖图。
网页从当前原生图推导真实选择者，先关闭选择者，再关闭故障输出；
对于这两份请求，合法推荐为 `luci-app-cjdns=N`、`cjdns=N`。
共享依赖仍被其他应用需要时必须保留，故障输出单独启用为 M 也必须处理。

推荐的多步操作共用一份事务偏好：已经接受的 N 不得在后续操作中被导入时的旧 Y 恢复。
只取消本次批准的动作和目标的保护状态，不修改原始导入偏好，不解除无关包保护。
此修复属于共享 planner，不包含包名、Source 或规则 ID 判断。

精确规则同时匹配源码提交、inputsHash、目标和已验证 GCC_VERSION。
源码、feeds、目标或工具链改变后不外推；缺少条件证据保持待定，不猜测为真。
旧请求继续读取；带 inputHashes 的新事实不降级成不认识精确身份的旧消费者规则。

## 验证与发布

回归覆盖精确身份及反例、M/Y、直接选择和图依赖入口、导出/再检测、
共享依赖保留、导入偏好不变和跨步骤事务。两份真实请求在本地网页使用实际 Catalog 原生数据、
暂存规则验证推荐点击、完整 .config 导出及 schema-6 覆盖值重建；
2 种主题 × 4 种视口 × 2 份请求共 16 组弹窗边界检查通过。

本变更复用兼容资产族根资产发布快路径，不改变原生数据生成器或触发完整重建。
Worker、上游源码补丁和构建前审查均不修改；用户仍可强制继续并由 Worker 原样执行。
这是已知故障的标准化预防推荐，不是修好了上游 cjdns，
也不证明构建中尚未完成的其他软件包都能成功。
本地验证不替代 fix CI 和 dev 频道发布后的实际网页验收。
