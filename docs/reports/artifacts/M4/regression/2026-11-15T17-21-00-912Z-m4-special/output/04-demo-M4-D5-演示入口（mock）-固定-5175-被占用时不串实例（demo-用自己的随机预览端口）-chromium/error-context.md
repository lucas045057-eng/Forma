# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: 04-demo.spec.ts >> M4-D5 演示入口（mock） >> 固定 5175 被占用时不串实例（demo 用自己的随机预览端口）
- Location: tests\e2e\m4\04-demo.spec.ts:342:3

# Error details

```
Error: listen EADDRINUSE: address already in use 127.0.0.1:5175
```