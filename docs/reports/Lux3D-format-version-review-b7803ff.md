# b7803ff 根静态复核补充

根复核 config 保守门禁及新增回归，未运行测试。混合标记用例已按 merge abort 后重新读的合同更正；include/refStorage/objectFormat/extensions 任意信号与配置非普通文件、链接、超大、读取失败仍回退旧 abort。源码安全校验、prune/audit、原5秒及审批断言均保留。

补一处边界：不能只统计完整正则匹配的版本行。普通 version=0 后追加 `repositoryformatversion = 1 # comment` 时，旧正则只匹配第一行，从而错误认作唯一声明。现在先要求全文 repositoryformatversion 字样恰出现一次，再要求该唯一声明格式明确且为0。注释或路径包含该字样也会保守回退原命令，这是预期取舍。

新增对应 config 负例，仍在私有临时配置上直接测试门禁，不让 Git 解析非法输入造成错误归因。其余状态回归不变。

本补充仅静态闭合边界。后续一次统一验证仍为 workspace typecheck 后四文件 asset-ledger/repo/approvals/scheduler，不声称审批超时已修复或 junction 已运行通过。
