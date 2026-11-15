# M4统一返工一：合并集中首轮与完整终审

## 执行顺序

用户要求先完成全部开发，再集中测试审查，避免逐小卡循环。现在集中首轮与统一终审都已交回：**一次修完本清单、补齐测试代码、统一交付；返工过程中不启动任何测试/构建/浏览器/服务/探针或新审查**。完成后由Codex安排集中验证与统一复审，不按B1/F1各跑一轮。不需要再问开工许可。

实现仅`.worktrees/m4` / `feat/m4-demo`，当前固定`9d717fc396cc4315f6ffcc636510868e8147dc82`（完整实现fd38840）；tracked干净、fallback未跟踪。Pi验收树`2f86b73bebc9459c88c65f27df3b82b0fa9e2482`冻结不动，主线也不做实现。读取root最新任务/报告即可，不必为读文档强行合并主线。

原始报告：根`docs/reports/M4-final-review.md`（2 blocker/6 should-fix/10建议）；Pi树`docs/reports/M4-test.md`（P1–P5）及`artifacts/M4/regression/2026-11-15T09-15-07-076Z-full`。旧job整体exit1，typecheck子步骤exit2；Studio类型、build、所有单测/脚本安全/13新E2E/174旧回归均没执行。**F1所谓“假绿”是夹具未覆盖真实拓扑的静态缺陷，不存在这轮真实测试已绿的证据。** 保留全部历史事实。

## 一次修复范围

| 项 | 最小必要修正 | 需补齐、留待集中执行的验证代码/场景 |
| --- | --- | --- |
| B1 = Pi P1 | `scene/service.ts`明确provenanceBytes的Buffer类型，兼容readPlainFile返回值；不cast隐藏坏数据、不改运行语义 | 新成品全仓类型/构建/单测，不能用旧547抵扣 |
| B2 | demo backend使用本轮plan的preview端口；mock和real都传递，不能退回5175。优先最小环境接线，不扩无关接口 | 用mock实际生成候选，验证HMR目标为plan.ports.preview、无循环navigation；5175被其它自有测试实例占用时不串到它 |
| F1 | 区分在途采集/转写与已完成review。permission/recording/transcribing在blur/门禁/blocked时取消并释放；review不因真实iframe失焦、pick pending、短暂WS重连/任务锁就丢失，而应保留并禁用确认，待当前ready显示A/B冲突。场景hidden可以明确放弃review，但需文档固定，不能影响正常点选B路径 | 补真实App/跨源iframe焦点+pending链，不仅同文档fixture-B按钮；review→iframe选B后仍有冲突且明确确认B，断线重连review保留；原有在途取消与晚权限资源释放不回退 |
| F2 | 任务POST确认成功后释放旧语音binding/latestBinding；失败/响应不明保守保持。用户成功提交语音后再编辑新的文字，不受历史语音版本绑定阻塞，放弃旧语音不能清掉用户新输入 | 语音提交→采用/版本变化或改选→新文字可直接生成，无旧binding冲突；与语音确认后尚未提交就改选必须再确认的安全合同区分 |
| F3 | demo ownedLifetime在父IPC断开时开始有界退出期限，不依赖已死启动器的兜底；先正常关闭，期限到安全记录并失败退出。验证设计须覆盖backend/frontends/检查/预览/资产worker等孙进程，不只process.exit让子孙漏掉 | 父进程硬杀后按PID+创建时间确认整条自有链在期限内退出；SIGINT正常退出status=stopped/forced=false；不广杀、不得把观测当通过 |
| F4 | 采用时损坏provenance JSON/过大/字段冲突统一映射安全409 ASSET_NAME_CONFLICT，不冒500或回显内部数据，作品/配置不推进 | 坏JSON、超限、合法字段不同三类409且GLB/parts/config/已有sidecar字节不变 |
| F5 | 补齐D3既定路径的关键测试代码；若静态发现真实缺陷连同修复，但不增生产HTTP后门 | UI真实空对象POST正常200/202；32MiB及+1、GLB version/声明长度坏；处理中后端父死worker退出/自身临时文件归属；legacy无fingerprint/LOCAL_IMPORT_INTERRUPTED重导；持久失败使idle/close失败并保留所有权 |
| F6 | 补demo脚本本体的隔离与守卫测试代码，集中入口要确实包含；已有Pi入口显式node --test scripts/demo/safety.test.mjs，不能误称完全未纳入，不必为凑覆盖改标准脚本造成重复执行 | 临时仓库prepare白名单/诱饵.env/祖先junction/plan越界及端口篡改；DNS域名/TCP/fetch守卫实际调用边界，纯IP本地lookup可行但外部connect不准；启动/关闭/父死不只测纯函数 |

不得为F1简单删除所有取消或selection门禁；保留在途隐私/计费取消及review确认后的最终对象绑定。不得为F2把所有对象变化自动套给B。F3不能通过全局taskkill按进程名实现，也不能假装hard kill后graceful状态成功。F5生产路径读取、hash与测试构造旁路的隔离仍需保留。

## 10条非阻断建议的处置

一并逐条标“已处理/保留限制/由集中验证确认”，不扩大为新项目，不必每项改代码。尤其：

- S1来源badge/demo横幅改变iframe/工作区高度，集中阶段必须重跑M1-B23并截1440×900 demo；若静态布局已明确错误可在本轮一并修，不能调像素阈值。
- S2超宽横滚的主光手柄不要被overflow-y隐藏；S3装饰/焦点已成立不必重写。
- S4来源hash重复刷新可去重，但不要用只看mtime/size的缓存掩盖真实GLB篡改；本轮不是性能重构。
- S5后端重新connected时可重取只读speech config，不能自动开始录音或重复发送付费请求；S6无识别文字给出“未识别到语音”，保留安全文本。
- S7资产安全错误可改善提示，不回显原始响应/秘密；S8默认来源两个hash已核成立，不杜撰任务链/时间。
- S9Windows Ctrl+C启动器与子进程同时收信号的状态竞态可和F3一起修，正常关闭不误报interrupted；仍把强杀/清理失败记失败。
- S10 D1字段改写语义已审成立，但新全仓必须覆盖，不能沿用旧字节成绩。

## 角色与交付

CodeBuddy修产品和实现测试代码，可按内容精确commit保存，但全部修完再一次交回，不逐项起验证或求审查。不要改Pi已入库独立E2E/原断言；Pi将在新冻结字节上独立补真实App iframe/语音后新文字、候选HMR及父死清理断言。来源sidecar/真实阿里/预览分源/审批与采用门禁仍按M4-plan，真实语音主链阿里云百炼。

写`docs/reports/M4-rework-1-impl.md`，逐项回应B1/B2/F1–F6和10建议，准确列修改文件/接口/状态语义、补写测试文件、旧问题原件路径、哪些未运行。新类型/逻辑尚未执行不能写“修复验证通过”；原测试/审查报告不改写，可新增回应文档。

本任务不运行typecheck/build/单测/浏览器/collect/demo/服务或独立审查，不读取真实.env/ASKS/凭据、不调用阿里/厂商语音/编码/Lux3D。允许静态源码阅读、diff --check、哈希和git核对，无新依赖/锁，fallback未跟踪且不入库，不动旧树。精确add，所有git用longpaths，无reset/clean，最终tracked干净、固定HEAD交回，不merge、不push、不标M4或项目完成。

完工后Codex统一冻结：Pi集中从头类型/构建/全量单测/脚本安全/D2真实Chromium组件/新M4独立套件+旧174，实际数随新增用例变化不预填；Claude统一复审所有修正。真实阿里质量、真人A-B、三次完整彩排未执行仍要分开说明。
