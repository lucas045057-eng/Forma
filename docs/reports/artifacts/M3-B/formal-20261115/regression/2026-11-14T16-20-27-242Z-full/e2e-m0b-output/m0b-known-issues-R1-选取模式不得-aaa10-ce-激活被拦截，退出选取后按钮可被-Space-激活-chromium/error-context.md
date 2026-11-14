# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: m0b-known-issues.spec.ts >> R1 选取模式不得触发先于/绕过 click 的业务行为 >> R1f 选取模式下 Space 激活被拦截，退出选取后按钮可被 Space 激活
- Location: tests\e2e\m0b-known-issues.spec.ts:127:3

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