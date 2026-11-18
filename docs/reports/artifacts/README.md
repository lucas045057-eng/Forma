# 历史测试运行证据索引（已收敛）

为避免 **8,166** 个历史测试运行条目（8,165 个文件 + 1 个历史 gitlink，原始大小 **902.37 MiB**，最长相对路径 265 字符）长期驻留日常工作树、拖慢 Git 操作并触发 Windows `MAX_PATH` 限制，本分支已将 `docs/reports/artifacts/` 下的历史产物收敛为本索引与 [ARCHIVE-INDEX.json](./ARCHIVE-INDEX.json)。

## 原始字节完整性与按需取回

所有原始证据的 Git 对象（blob 与 tree）**100% 完整保留在本地仓库对象库及 `master` 基线提交 `38b69ff8fb5baf6f90101ba468fb7289c915da78` 中**，未做任何改写或重压缩。

- **不检出直接查看单个历史证据文件**：
  ```sh
  git show 38b69ff8fb5baf6f90101ba468fb7289c915da78:docs/reports/artifacts/M0-B/playwright-results.json
  ```
- **按需临时恢复某一里程碑目录到本地**：
  ```sh
  git -c core.longpaths=true checkout 38b69ff8fb5baf6f90101ba468fb7289c915da78 -- docs/reports/artifacts/M4
  ```

## 各里程碑归档概览（基线 `38b69ff`）

| 里程碑目录 | 文件数 | 原始总大小 | Git Tree SHA |
| --- | ---: | ---: | --- |
| `M4` | 5,163 (含 1 gitlink) | 881.58 MiB | `075462c5c493f33121c123b1ea44ac17291efcf2` |
| `M3-B` | 1,430 | 7.37 MiB | `e1da92f168167bab9ea27b6138f458e6d2260c73` |
| `M3-C` | 590 | 3.94 MiB | `95bbed06e8e64fe4112051e25e0bed494b99c686` |
| `M3-A` | 374 | 2.41 MiB | `ab86695c68fe5e6e63fbb1872665f3416b320509` |
| `M2-final` | 238 | 1.03 MiB | `d6bcef1a1d953cd58372a0142f0fa10c45f834fd` |
| `M2-real-model` | 110 | 4.53 MiB | `d8b218eb9f3ebc58c56c1aa68512949b2097d437` |
| `M1-B` | 73 | 0.42 MiB | `2513b8a22462df886b3c31e1aabc90dde7f93612` |
| `M2-A` | 58 | 0.30 MiB | `7679512ece7f56cd2feaee04def2e857324b23f8` |
| `M2-N4` | 46 | 0.16 MiB | `aade8e20ae2c3f9ee5c7d2e25b1b04e86127f14f` |
| `M0-A` | 30 | 0.34 MiB | `0b62f49a1980e9c41963a5965a954c1b7cd5e089` |
| `M2-B` | 23 | 0.24 MiB | `1b9083f3cb3a300b79066df20691ac4bd47875e2` |
| `M0-B` | 22 | 0.03 MiB | `cb8b747b3a72ec4786054f30d66e160f3d17bbe5` |
| `M1-A` | 9 | 0.03 MiB | `abaa4c7c11fe15159079cb4effb7d125bc2d8539` |
| **合计** | **8,166** | **902.37 MiB** | `75081fa0e21923d3b215c3a634b125254167f36c` |

## 本地测试输出约定

`.gitignore` 已配置忽略 `docs/reports/artifacts/*` 下由本地运行 `pnpm test:e2e*` 新生成的临时结果文件（仅保留 `README.md` 与 `ARCHIVE-INDEX.json`），日常运行 E2E 不会再污染 Git 工作区。
