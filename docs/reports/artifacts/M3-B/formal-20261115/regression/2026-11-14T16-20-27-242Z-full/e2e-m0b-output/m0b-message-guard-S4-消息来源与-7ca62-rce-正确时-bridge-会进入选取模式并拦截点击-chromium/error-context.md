# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: m0b-message-guard.spec.ts >> S4 消息来源与形状校验 >> S4b 对照：source 正确时 bridge 会进入选取模式并拦截点击
- Location: tests\e2e\m0b-message-guard.spec.ts:87:3

# Error details

```
Error: browserType.launch: Executable doesn't exist at C:\Users\Admin\AppData\Local\ms-playwright \chromium_headless_shell-1254\chrome-headless-shell-win64\chrome-headless-shell.exe
╔════════════════════════════════════════════════════════════╗
║ Looks like Playwright was just installed or updated.       ║
║ Please run the following command to download new browsers: ║
║                                                            ║
║     npx playwright install                                 ║
║                                                            ║
║ <3 Playwright Team                                         ║
╚════════════════════════════════════════════════════════════╝
```