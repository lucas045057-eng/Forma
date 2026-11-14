# run6 末步（e2e-m3b）的未跟踪 checks 证据（归属说明）

本目录是 **run6**（`regression/2026-11-14T17-58-50-889Z-full`，job_4fcf7cab，
起跑 2026-11-14T17:58:51Z、末步结束 2026-11-14T18:15:2xZ，**11/11 步全绿**）
里 e2e-m3b 这一步写出的 6 份**未跟踪**结构化证据。

同一轮里已跟踪的 7 份（`disposals-01..04`、`happy-path.json`、
`evidence-01-happy/{occlusion,smoke}.json`）由 `full-regression.mjs` 的归档守卫处理：
新字节归档到 `../evidence-refresh/e2e-m3b/docs/reports/artifacts/M3-B/formal-20261115/checks/`，
再按 git blob 还原（manifest 里逐份记录了 `headBlobId`/`restoredObjectId`、`statusClean: true`）。
这 6 份因为从未入库，守卫不接管，所以在本轮收尾时人工归档到这里并从 `checks/` 移除——
不删字节，只是把它们和"当前已提交快照"分开，避免下一轮起跑前被证据脏判据拦下。

文件（字节数）：

```
fault-classes.json	14473B
gate.json	7911B
lifecycle-cancel.json	975B
lifecycle-missing-browser.json	3837B
lifecycle-restart.json	1534B
lifecycle-serial.json	6450B
```
