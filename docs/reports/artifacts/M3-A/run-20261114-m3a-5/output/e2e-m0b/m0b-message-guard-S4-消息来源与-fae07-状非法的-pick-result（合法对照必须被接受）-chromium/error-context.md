# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: m0b-message-guard.spec.ts >> S4 消息来源与形状校验 >> S4c Studio 忽略形状非法的 pick:result（合法对照必须被接受）
- Location: tests\e2e\m0b-message-guard.spec.ts:107:3

# Error details

```
Error: Selection 面板还没有内容
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
        - text: 事件已连接 ·
        - status [ref=e12]: "0"
      - button "退出选取" [active] [pressed] [ref=e13] [cursor=pointer]
  - generic [ref=e14]:
    - region "作品预览" [ref=e15]:
      - generic [ref=e16]:
        - generic [ref=e17]: 作品 / 木间香薰
        - generic [ref=e18]: 选取模式 · 点击查看源码 · 40%
      - generic [ref=e19]:
        - generic [ref=e20]:
          - text: 作品版本
          - code [ref=e21]: 24562691c3
        - button "回退上一次采用" [ref=e22] [cursor=pointer]
      - iframe [ref=e24]:
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
    - complementary [ref=e25]:
      - paragraph [ref=e26]: SOURCE INSPECTOR
      - heading "选中对象" [level=2] [ref=e27]
      - paragraph [ref=e28]: 开启选取后，点击左侧页面。青色边框标出共享同一处源码的所有实例。
      - generic [ref=e29]:
        - strong [ref=e30]: GuardProbe
        - code [ref=e31]: src/App.tsx:1:1
      - paragraph [ref=e32]: 同源码实例：1 处
      - generic [ref=e33]: "{ \"src\": \"src/App.tsx:1:1\", \"cid\": \"GuardProbe\", \"text\": \"合法对照\", \"bbox\": [ 1, 2, 3, 4 ], \"styles\": { \"display\": \"block\", \"position\": \"static\", \"color\": \"rgb(0, 0, 0)\", \"backgroundColor\": \"rgba(0, 0, 0, 0)\", \"fontSize\": \"16px\", \"fontFamily\": \"sans-serif\", \"fontWeight\": \"400\", \"lineHeight\": \"normal\", \"padding\": \"0px\", \"margin\": \"0px\", \"borderRadius\": \"0px\", \"width\": \"10px\", \"height\": \"10px\" }, \"instances\": 1, \"ancestors\": [], \"baseVersion\": \"24562691c34cbbbcb44df844a6ac214dfe193044\" }"
      - region "指着说" [ref=e34]:
        - paragraph [ref=e35]: POINT & SPEAK
        - heading "指着说" [level=2] [ref=e36]
        - generic [ref=e37]:
          - text: 修改指令
          - textbox "修改指令" [ref=e38]:
            - /placeholder: 例如：把这个按钮改成“马上购买”
        - paragraph [ref=e39]: 将携带 src/App.tsx:1:1 作为选中对象。 Ctrl/⌘ + Enter 提交。
        - button "生成候选版本" [disabled] [ref=e40]
```

# Test source

```ts
  158 | 
  159 | /**
  160 |  * 找一个「命中的就是该元素本身」的视口内坐标（padding / 文字等未被后代覆盖的区域）。
  161 |  * 容器类元素常被后代完全覆盖，此时返回 null。
  162 |  */
  163 | async function findHitPoint(
  164 |   frame: Frame,
  165 |   target: { index?: number; selector?: string },
  166 | ): Promise<{ x: number; y: number } | null> {
  167 |   return frame.evaluate((arg) => {
  168 |     const element = arg.index !== undefined
  169 |       ? (document.querySelectorAll('[data-src]')[arg.index] as HTMLElement | undefined)
  170 |       : (document.querySelector(arg.selector ?? '') as HTMLElement | null);
  171 |     if (!element) return null;
  172 |     const rect = element.getBoundingClientRect();
  173 |     const steps = 16;
  174 |     const vw = window.innerWidth;
  175 |     const vh = window.innerHeight;
  176 |     for (let ix = 1; ix < steps; ix += 1) {
  177 |       for (let iy = 1; iy < steps; iy += 1) {
  178 |         const x = rect.left + (rect.width * ix) / steps;
  179 |         const y = rect.top + (rect.height * iy) / steps;
  180 |         if (x < 0 || y < 0 || x >= vw - 1 || y >= vh - 1) continue;
  181 |         if (document.elementFromPoint(x, y) === element) return { x, y };
  182 |       }
  183 |     }
  184 |     return null;
  185 |   }, target);
  186 | }
  187 | 
  188 | export type ClickMode = 'mouse' | 'dom-dispatch';
  189 | 
  190 | export interface ClickOptions {
  191 |   button?: 'left' | 'right';
  192 |   clicks?: 1 | 2;
  193 | }
  194 | 
  195 | /**
  196 |  * 在预览页里点击目标。
  197 |  * 优先用真实鼠标事件（page.mouse），坐标由 iframe 在 Studio 中的位置换算；
  198 |  * 若元素被后代完全覆盖（容器类），退化为在元素自身上派发冒泡 click，
  199 |  * 仍会经过 bridge 的 window capture 拦截逻辑。实际使用的方式会被记录。
  200 |  * 右键 / 双击：传 options.button = 'right' 或 options.clicks = 2。
  201 |  */
  202 | export async function clickTarget(
  203 |   page: Page,
  204 |   frame: Frame,
  205 |   target: { index?: number; selector?: string },
  206 |   options: ClickOptions = {},
  207 | ): Promise<ClickMode> {
  208 |   await scrollIntoView(frame, target);
  209 |   const point = await findHitPoint(frame, target);
  210 |   if (point) {
  211 |     const box = await page.locator('[data-testid="preview-frame"]').boundingBox();
  212 |     if (!box) throw new Error('预览 iframe 没有布局盒');
  213 |     const x = box.x + point.x;
  214 |     const y = box.y + point.y;
  215 |     if (options.clicks === 2) await page.mouse.dblclick(x, y, { button: options.button ?? 'left' });
  216 |     else await page.mouse.click(x, y, { button: options.button ?? 'left' });
  217 |     return 'mouse';
  218 |   }
  219 |   await frame.evaluate((arg) => {
  220 |     const element = arg.index !== undefined
  221 |       ? (document.querySelectorAll('[data-src]')[arg.index] as HTMLElement | undefined)
  222 |       : (document.querySelector(arg.selector ?? '') as HTMLElement | null);
  223 |     if (!element) throw new Error('点击目标不存在');
  224 |     element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, detail: 1 }));
  225 |   }, target);
  226 |   return 'dom-dispatch';
  227 | }
  228 | 
  229 | /** 把鼠标移到目标上（不按下），用于验证悬停高亮仍工作。 */
  230 | export async function hoverTarget(
  231 |   page: Page,
  232 |   frame: Frame,
  233 |   target: { index?: number; selector?: string },
  234 | ): Promise<void> {
  235 |   await scrollIntoView(frame, target);
  236 |   const point = await findHitPoint(frame, target);
  237 |   if (!point) throw new Error('找不到可悬停的点');
  238 |   const box = await page.locator('[data-testid="preview-frame"]').boundingBox();
  239 |   if (!box) throw new Error('预览 iframe 没有布局盒');
  240 |   await page.mouse.move(box.x + point.x, box.y + point.y);
  241 |   await page.waitForTimeout(200);
  242 | }
  243 | 
  244 | /** 覆盖层里「悬停框」的数量：bridge 把悬停框画成橙色边框，选中框是青色。 */
  245 | export async function hoverBoxCount(frame: Frame): Promise<number> {
  246 |   return frame.evaluate(() => Array.from(document.querySelectorAll('[data-highlight-src]'))
  247 |     .filter((element) => (element as HTMLElement).style.borderColor.replace(/\s/g, '').includes('245,158,11')).length);
  248 | }
  249 | 
  250 | export async function selectionText(page: Page): Promise<string> {
  251 |   const panel = page.locator('[data-testid="selection-json"]');
  252 |   if ((await panel.count()) === 0) return '';
  253 |   return panel.innerText();
  254 | }
  255 | 
  256 | export async function readSelection(page: Page): Promise<Record<string, unknown>> {
  257 |   const text = await selectionText(page);
> 258 |   if (!text) throw new Error('Selection 面板还没有内容');
      |                    ^ Error: Selection 面板还没有内容
  259 |   return JSON.parse(text) as Record<string, unknown>;
  260 | }
  261 | 
  262 | export async function waitForSelectionChange(page: Page, before: string): Promise<void> {
  263 |   await page.waitForFunction(
  264 |     (previous) => {
  265 |       const panel = document.querySelector('[data-testid="selection-json"]');
  266 |       return panel !== null && panel.textContent !== previous;
  267 |     },
  268 |     before,
  269 |     { timeout: 15_000 },
  270 |   );
  271 | }
  272 | 
  273 | /** 选中一个带标记的元素并返回 Selection。 */
  274 | export async function pickMarked(
  275 |   page: Page,
  276 |   frame: Frame,
  277 |   index: number,
  278 | ): Promise<{ mode: ClickMode; selection: Record<string, unknown> }> {
  279 |   const before = await selectionText(page);
  280 |   const mode = await clickTarget(page, frame, { index });
  281 |   await waitForSelectionChange(page, before);
  282 |   return { mode, selection: await readSelection(page) };
  283 | }
  284 | 
  285 | export async function setPicking(page: Page, on: boolean): Promise<void> {
  286 |   const toggle = page.locator('[data-testid="pick-toggle"]');
  287 |   const pressed = await toggle.getAttribute('aria-pressed');
  288 |   if ((pressed === 'true') !== on) {
  289 |     await toggle.click();
  290 |     await page.waitForFunction(
  291 |       (expected) => document.querySelector('[data-testid="pick-toggle"]')?.getAttribute('aria-pressed') === String(expected),
  292 |       on,
  293 |       { timeout: 10_000 },
  294 |     );
  295 |   }
  296 |   await page.waitForTimeout(150);
  297 | }
  298 | 
  299 | /** 高亮覆盖层里对应 src 的框数量。 */
  300 | export async function highlightBoxCount(frame: Frame, src: string): Promise<number> {
  301 |   return frame.evaluate(
  302 |     (value) => Array.from(document.querySelectorAll('[data-highlight-src]'))
  303 |       .filter((el) => el.getAttribute('data-highlight-src') === value).length,
  304 |     src,
  305 |   );
  306 | }
  307 | 
  308 | /**
  309 |  * 按「标签 + 自身静态文本」在预览页里定位元素，命中后临时打上 `data-e2e-target`，
  310 |  * 方便复用已有的真实鼠标点击逻辑。返回命中个数（应当正好 1 个）。
  311 |  * 自身文本 = 直接子级文本节点拼起来并折叠空白，和 AST 侧 JSXText 的口径一致。
  312 |  */
  313 | export async function markByOwnText(frame: Frame, tag: string, ownText: string): Promise<number> {
  314 |   return frame.evaluate(({ tag: tagName, text }) => {
  315 |     const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
  316 |     const ownTextOf = (element: Element) => normalize(
  317 |       Array.from(element.childNodes)
  318 |         .filter((node) => node.nodeType === Node.TEXT_NODE)
  319 |         .map((node) => node.textContent ?? '')
  320 |         .join(''),
  321 |     );
  322 |     const matches = Array.from(document.querySelectorAll(tagName)).filter((element) => ownTextOf(element) === text);
  323 |     for (const element of matches) element.setAttribute('data-e2e-target', '1');
  324 |     return matches.length;
  325 |   }, { tag, text: ownText });
  326 | }
  327 | 
  328 | export async function clearE2eMarks(frame: Frame): Promise<void> {
  329 |   await frame.evaluate(() => {
  330 |     for (const element of Array.from(document.querySelectorAll('[data-e2e-target]'))) element.removeAttribute('data-e2e-target');
  331 |   });
  332 | }
  333 | 
  334 | /** 点击一个已被 `markByOwnText` 标记的元素。 */
  335 | export async function clickMarkedByText(page: Page, frame: Frame): Promise<ClickMode> {
  336 |   const mode = await clickTarget(page, frame, { selector: '[data-e2e-target="1"]' });
  337 |   await clearE2eMarks(frame);
  338 |   return mode;
  339 | }
  340 | 
  341 | /** 在预览页里注入一个探针对象，并把事件监听器挂在指定元素上（只影响本次页面，不改模板）。 */
  342 | export async function installEventProbe(frame: Frame, selector: string): Promise<void> {
  343 |   await frame.evaluate((target) => {
  344 |     const probe: Record<string, number> = {
  345 |       pointerdown: 0, mousedown: 0, mouseup: 0, click: 0, auxclick: 0,
  346 |       dblclick: 0, contextmenu: 0, submit: 0, keydown: 0, keyup: 0,
  347 |     };
  348 |     (window as unknown as { __probe: Record<string, number> }).__probe = probe;
  349 |     const element = document.querySelector(target);
  350 |     if (!element) throw new Error(`探针挂载目标不存在：${target}`);
  351 |     for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click', 'auxclick', 'dblclick', 'contextmenu']) {
  352 |       element.addEventListener(type, () => { probe[type] += 1; }, true);
  353 |     }
  354 |     element.addEventListener('keydown', () => { probe.keydown += 1; }, true);
  355 |     element.addEventListener('keyup', () => { probe.keyup += 1; }, true);
  356 |   }, selector);
  357 | }
  358 | 
```