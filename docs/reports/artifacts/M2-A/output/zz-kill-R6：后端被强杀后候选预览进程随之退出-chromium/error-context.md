# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: zz-kill.spec.ts >> R6：后端被强杀后候选预览进程随之退出
- Location: tests\e2e\m2a\zz-kill.spec.ts:18:1

# Error details

```
Error: 后端被杀后候选预览进程还在

expect(received).toBe(expected) // Object.is equality

Expected: true
Received: false
```

# Page snapshot

```yaml
- main [ref=e3]:
  - generic [ref=e4]:
    - generic [ref=e5]:
      - text: ORBIT / STUDIO
      - heading "空间化 AI 创作工作台" [level=1] [ref=e6]
    - generic [ref=e7]:
      - button "3D 场景编辑" [ref=e8] [cursor=pointer]
      - button "3D 资产" [ref=e9] [cursor=pointer]
      - generic [ref=e10]: 预览已连接
      - generic [ref=e11]:
        - text: 事件重连中 ·
        - status [ref=e12]: "13"
      - button "开启选取" [active] [ref=e13] [cursor=pointer]
  - generic [ref=e14]:
    - region "作品预览" [ref=e15]:
      - generic [ref=e16]:
        - generic [ref=e17]: 作品 / 木间香薰
        - generic [ref=e18]: 浏览模式 · 40%
      - generic [ref=e19]:
        - generic [ref=e20]:
          - text: 作品版本
          - code [ref=e21]: c6ff70d6f4
        - button "回退上一次采用" [ref=e22] [cursor=pointer]
        - combobox "待定候选版本" [ref=e23]:
          - option "候选 11dad506" [selected]
        - generic "预览模式" [ref=e24]:
          - button "当前版本" [pressed] [ref=e25] [cursor=pointer]
          - button "候选版本" [ref=e26] [cursor=pointer]
          - button "并排对比" [ref=e27] [cursor=pointer]
      - iframe [ref=e29]:
        - main [ref=f1e3]:
          - generic [ref=f1e4]:
            - link "木间 MUJIAN / SCENT & LIVING" [ref=f1e5] [cursor=pointer]:
              - /url: "#home"
              - text: 木间
              - generic [ref=f1e6]: MUJIAN / SCENT & LIVING
            - link "关于这缕香气" [ref=f1e7] [cursor=pointer]:
              - /url: "#details"
          - generic [ref=f1e8]:
            - generic [ref=f1e9]:
              - paragraph [ref=f1e10]: A LITTLE SPACE TO BREATHE
              - heading "给生活， 留一点香气。" [level=1] [ref=f1e11]: 给生活，留一点香气。
              - paragraph [ref=f1e12]: 把森林的温柔带回家。木间 · 雪松无火香薰，让每一次回家都值得期待。
              - generic [ref=f1e13]: ¥ 168 / 100 mL · 雪松与佛手柑
              - generic [ref=f1e14]:
                - button "立即购买" [ref=f1e15] [cursor=pointer]
                - button "收藏香气" [ref=f1e16] [cursor=pointer]
              - paragraph [ref=f1e17]: 一份给自己，也给生活的温柔礼物。
            - generic "香薰三维展示" [ref=f1e18]
          - generic [ref=f1e22]:
            - paragraph [ref=f1e23]: SMALL RITUALS, EVERY DAY
            - heading "不必远行，也能亲近自然。" [level=2] [ref=f1e24]
            - list [ref=f1e25]:
              - listitem [ref=f1e26]:
                - text: "01"
                - heading "让呼吸慢下来" [level=3] [ref=f1e27]
                - paragraph [ref=f1e28]: 雪松与佛手柑，像雨后走进一片安静的森林。
              - listitem [ref=f1e29]:
                - text: "02"
                - heading "让角落有温度" [level=3] [ref=f1e30]
                - paragraph [ref=f1e31]: 琥珀色瓶身与木质瓶盖，把自然留在你喜欢的角落。
              - listitem [ref=f1e32]:
                - text: "03"
                - heading "让日常有仪式" [level=3] [ref=f1e33]
                - paragraph [ref=f1e34]: 读书、休息、等一杯茶，让淡淡香气陪你片刻。
            - button "为重要的人选一份" [ref=f1e35] [cursor=pointer]
          - generic [ref=f1e36]: 木间 MUJIAN · 留一隅安静，给自己。
          - status
      - generic [ref=e30]:
        - generic [ref=e31]:
          - heading "候选 11dad506" [level=2] [ref=e32]
          - generic [ref=e33]: 待定候选 1/3
        - generic [ref=e34]:
          - generic [ref=e35]: 构建：未检查
          - generic [ref=e36]: 冒烟：未检查
          - generic [ref=e37]: 遮挡：未检查
          - generic [ref=e38]: Schema：未检查
        - generic [ref=e39]:
          - heading "改动文件" [level=3] [ref=e40]
          - list [ref=e41]:
            - listitem [ref=e42]:
              - code [ref=e43]: src/App.tsx
          - region "差异 src/App.tsx" [ref=e44]:
            - code [ref=e45]: src/App.tsx
            - generic [ref=e46]:
              - generic [ref=e47]: diff --git a/src/App.tsx b/src/App.tsx
              - generic [ref=e48]: index c9ef103..88b587a 100644
              - generic [ref=e49]: "--- a/src/App.tsx"
              - generic [ref=e50]: +++ b/src/App.tsx
              - generic [ref=e51]: "@@ -24,7 +24,7 @@ export default function App() {"
              - generic [ref=e52]: <p className="intro">把森林的温柔带回家。<br/>木间 · 雪松无火香薰，让每一次回家都值得期待。</p>
              - generic [ref=e53]: <div className="price">¥ 168 <span> / 100 mL · 雪松与佛手柑</span></div>
              - generic [ref=e54]: <div className="actions">
              - generic [ref=e55]: "- <Button data-testid=\"buy-button\" onClick={() => { setPurchases(value => value + 1); setAction('已加入购物袋（演示）'); }}>立即购买</Button>"
              - generic [ref=e56]: "+ <Button data-testid=\"buy-button\" onClick={() => { setPurchases(value => value + 1); setAction('已加入购物袋（演示）'); }}>马上购买</Button>"
              - generic [ref=e57]: "<Button className=\"button-secondary\" data-testid=\"save-button\" onClick={() => setAction('已收藏这缕香气（演示）')}>收藏香气</Button>"
              - generic [ref=e58]: </div>
              - generic [ref=e59]: <p className="fine-print">一份给自己，也给生活的温柔礼物。</p>
        - generic [ref=e60]:
          - button "采用此候选" [ref=e61] [cursor=pointer]
          - button "撤回候选" [ref=e62] [cursor=pointer]
    - complementary [ref=e63]:
      - paragraph [ref=e64]: SOURCE INSPECTOR
      - heading "选中对象" [level=2] [ref=e65]
      - paragraph [ref=e66]: 开启选取后，点击左侧页面。青色边框标出共享同一处源码的所有实例。
      - generic [ref=e67]:
        - strong [ref=e68]: Button
        - code [ref=e69]: src/components/Button.tsx:5:5
      - paragraph [ref=e70]: 同源码实例：3 处；修改将影响全部实例（共享组件或列表项）。
      - generic [ref=e71]: "{ \"src\": \"src/components/Button.tsx:5:5\", \"cid\": \"Button\", \"text\": \"立即购买\", \"bbox\": [ 61.796875, 312.375, 104, 47 ], \"styles\": { \"display\": \"block\", \"position\": \"static\", \"color\": \"rgb(255, 250, 240)\", \"backgroundColor\": \"rgb(117, 96, 68)\", \"fontSize\": \"13px\", \"fontFamily\": \"\\\"Microsoft YaHei\\\", sans-serif\", \"fontWeight\": \"400\", \"lineHeight\": \"normal\", \"padding\": \"14px 25px\", \"margin\": \"0px\", \"borderRadius\": \"3px\", \"width\": \"104px\", \"height\": \"47px\" }, \"instances\": 3, \"ancestors\": [ \"src/App.tsx:26:11\", \"src/App.tsx:21:9\", \"src/App.tsx:20:7\" ], \"baseVersion\": \"c6ff70d6f485e622cb13dd4408a5a21ce1bde303\" }"
      - region "指着说" [ref=e72]:
        - paragraph [ref=e73]: POINT & SPEAK
        - heading "指着说" [level=2] [ref=e74]
        - generic [ref=e75]:
          - text: 修改指令
          - textbox "修改指令" [ref=e76]:
            - /placeholder: 例如：把这个按钮改成“马上购买”
        - paragraph [ref=e77]: 将携带 src/components/Button.tsx:5:5 作为选中对象。 Ctrl/⌘ + Enter 提交。
        - button "生成候选版本" [disabled] [ref=e78]
        - generic [ref=e79]:
          - generic [ref=e80]:
            - strong [ref=e81]: 候选已就绪
            - code [ref=e82]: 11dad506
          - paragraph [ref=e83]: 改按钮
          - list [ref=e84]:
            - listitem [ref=e85]: 任务已排队
            - listitem [ref=e86]: 开始校验选中对象并创建候选版本
            - listitem [ref=e87]: 候选目录已创建，编码 Agent 开始工作
            - listitem [ref=e88]: 请求编码模型（第 1/16 轮）
            - listitem [ref=e89]: 执行工具 read_file
            - listitem [ref=e90]: 请求编码模型（第 2/16 轮）
            - listitem [ref=e91]: 执行工具 replace_in_file
            - listitem [ref=e92]: 请求编码模型（第 3/16 轮）
            - listitem [ref=e93]: 执行工具 finish
            - listitem [ref=e94]: 编码 Agent 已完成修改
            - listitem [ref=e95]: 候选已提交，改动 1 个文件；正在启动预览
            - listitem [ref=e96]: ok
```

# Test source

```ts
  1  | import { execSync } from 'node:child_process';
  2  | import { expect, test } from '@playwright/test';
  3  | import { pickSelection, previewFetch, resetMock, restoreTemplate, setScript, submitTask, waitFor, waitForTask } from './api';
  4  | import { writeArtifactFrom } from './artifact';
  5  | 
  6  | /**
  7  |  * R6：后端被强杀后，候选预览进程（preview worker）应随之退出。
  8  |  * 这条会把后端杀掉，所以文件名排最后（zz-），不让后续用例依赖它还活着。
  9  |  */
  10 | 
  11 | const countPreviewVite = (): number => {
  12 |   try {
  13 |     const output = execSync("powershell -NoProfile -Command \"(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'vite.js' -and $_.CommandLine -match 'preview-cache' } | Measure-Object).Count\"", { encoding: 'utf8' });
  14 |     return Number(output.trim());
  15 |   } catch { return -1; }
  16 | };
  17 | 
  18 | test('R6：后端被强杀后候选预览进程随之退出', async ({ page }) => {
  19 |   const restored = restoreTemplate();
  20 |   expect(restored.clean, restored.status).toBe(true);
  21 |   await resetMock();
  22 |   await setScript([
  23 |     [{ name: 'read_file', args: { path: 'src/App.tsx' } }],
  24 |     [{ name: 'replace_in_file', args: { path: 'src/App.tsx', old: '立即购买', new: '马上购买' } }],
  25 |     [{ name: 'finish', args: { summary: 'ok' } }],
  26 |   ]);
  27 |   const selection = await pickSelection(page);
  28 |   const task = await waitForTask((await submitTask('改按钮', selection)).body.id);
  29 |   const id = task.candidateId!;
  30 |   expect((await previewFetch(`/preview/c/${id}/`)).status).toBe(200);
  31 |   const viteBefore = countPreviewVite();
  32 | 
  33 |   const list = execSync("powershell -NoProfile -Command \"(Get-NetTCPConnection -State Listen -LocalPort 3001 | Select-Object -First 1 -ExpandProperty OwningProcess)\"", { encoding: 'utf8' });
  34 |   const pid = Number(list.trim().split(/\s+/)[0]);
  35 |   expect(Number.isFinite(pid) && pid > 0, `没找到后端进程：${list}`).toBe(true);
  36 |   execSync(`taskkill /T /F /PID ${pid}`, { stdio: 'ignore' });
  37 | 
  38 |   const gone = await waitFor(() => countPreviewVite() === 0, 30_000, 500).then(() => true).catch(() => false);
  39 |   writeArtifactFrom('isolation-r6.json', { pid, viteBefore, viteAfter: countPreviewVite(), gone, candidateId: id });
> 40 |   expect(gone, '后端被杀后候选预览进程还在').toBe(true);
     |                                 ^ Error: 后端被杀后候选预览进程还在
  41 | });
  42 | 
```