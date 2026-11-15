# M3-C 视口布局整改集成记录（正式验收待执行）

独立复审与固定提交的窄检查已满足合并条件，本记录不构成M3-C验收结论。

- 实现提交：`393fe9f98c64822593591301518e246df8aa45e2`。
- 合并提交：`caa0ef018cf5b3b9a91816090c43b4df3f73ed26`。
- 合并后与实现的`apps`树均为`8df06a9b57fd8e00e98a0eb946ad9b6b5c8f64a8`。
- `git diff --exit-code 393fe9f HEAD -- apps packages templates pnpm-lock.yaml`为空。
- 锁SHA256：`67af36b7a1b8a8ace1f03aa0ca9addf979f3842bdab3ff3dc4f56901b7d18960`。
- 合并前后tracked工作树干净；后续仅追加本记录、复审报告与窄检查归档，不改产品字节。

产品增量只有`scene-editor.css`中的场景模式外层inspector去padding/border规则。原E2E断言、阈值、姿态逻辑、未保存草稿保护与审批/检查/采用门禁未改。原件像素诊断中第376列是SceneEditor自身边框，第377列是外层inspector的padding背景；外层空间挤压导致两列裁剪这一因果结论不变。

实现侧M1-B红灯18/23、修后23/23；GREEN受测身份是`0860fbb+CSS草稿`，与固定提交的受测字节绑定，不能声称在本合并提交重新跑过。固定`393fe9f`的`job_e6488103`已实际通过Studio typecheck和build，全部exit0/signal=null，前后身份一致。原始记录见`artifacts/M3-C/viewport-css-fixed-commit-check-20261115/`，红绿与图像原件见`artifacts/M3-C/viewport-css-fix/`。

Claude在`M3-C-viewport-review.md`给出blocker0、should-fix0、4项非阻断建议，并已只读核对类型/构建返回结果。卡片水平留白、超宽对照画布提示/缩放可留M4打磨；直接布局断言是测试方可选护栏，本轮不改原23项来掩盖失败。

下一步由Pi在独立m3c-acceptance工作树合入本次冻结主线，先证明产品/锁与`393fe9f`一致，再从头执行typecheck→build→完整单测→原八套E2E→M3-C，共12步、当前收集174例。原M1-B23项必须在新冻结身份上重新实际通过；首败即停，禁止以本次GREEN替代、跳步或自动补跑。所有失败历史、原始JSON/截图/刷新证据与清理记录继续保留，最终是否收口以Pi正式报告为准。
