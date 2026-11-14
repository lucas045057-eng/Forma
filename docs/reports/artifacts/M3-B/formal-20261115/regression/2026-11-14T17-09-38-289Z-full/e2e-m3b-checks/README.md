# run4 末步（e2e-m3b）自己写出的 checks 证据（归属说明）

本目录是 **run4**（`regression/2026-11-14T17-09-38-289Z-full`，job_05f1f133，
起跑 2026-11-14T17:09:38Z、末步结束 2026-11-14T17:25:56Z）里 e2e-m3b 这一步
**实际写出**的 `docs/reports/artifacts/M3-B/formal-20261115/checks/` 整份快照。

为什么在这里：run4 末步的 Playwright 报告是 7/7 全过（expected 7 / unexpected 0 /
skipped 0 / flaky 0、0 retry、code=0），但归档守卫判定 7 份**已跟踪**证据
"在本步开始前就已脏（归属不明）"，按设计拒绝覆盖，于是本步 `ok=false`、
`evidenceArchived=0`。也就是说这些字节之前没被归档过，只留在工作区里。

处理方式（不删任何字节、不改写内容）：
1. 先把 checks/ 里的 17 份（11 份已跟踪 + 6 份未跟踪）整份复制到这里，作为 run4 末步的证据留档；
2. 再把被 run4 改脏的 7 份已跟踪文件按 git blob 还原，6 份未跟踪文件从 checks/ 移除；
3. 这样 `git status --porcelain -- docs/reports/artifacts/M3-B/formal-20261115` 在 run5 起跑前为空，归档守卫不再误判。

因此本目录内容 = run4 末步产出；它不是 run#3（`2026-11-14T16-43-45-146Z-full`）的证据，
也不是产品失败证据。run4 的判定见 `docs/reports/M3-B-test.md` 的对应小节。

文件（字节数）：

```
disposals-01-happy.json	965B
disposals-02-faults.json	965B
disposals-03-gate.json	963B
disposals-04-lifecycle.json	967B
evidence-01-happy/build.log	386B
evidence-01-happy/occlusion.json	2717B
evidence-01-happy/occlusion.png	105365B
evidence-01-happy/schema.json	99B
evidence-01-happy/smoke.json	324B
evidence-01-happy/smoke.png	105365B
fault-classes.json	14469B
gate.json	7912B
happy-path.json	5816B
lifecycle-cancel.json	975B
lifecycle-missing-browser.json	3837B
lifecycle-restart.json	1534B
lifecycle-serial.json	6524B
```
