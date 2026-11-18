import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { compileHtmlToReactWork, sanitizeImportedCss } from './html-import.ts';

function assertValidTsx(source: string) {
  const sf = ts.createSourceFile('src/App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const diags = (sf as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  expect(diags).toEqual([]);
}

describe('compileHtmlToReactWork', () => {
  it('converts full HTML documents with styles, SVG, forms, void tags, and inline styles into valid JSX', () => {
    const html = `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <title>星河设计工作室 &mdash; 2026</title>
    <style>
      @import url("https://fonts.googleapis.com/css2?family=Inter");
      .hero { background: url("https://cdn.example.com/bg.jpg"); color: #111; }
    </style>
    <script>window.evil = true;</script>
  </head>
  <body class="theme-light">
    <!-- header comment -->
    <header class="site-header" style="display: flex; --accent-color: #2f6f7e; background-image: url('https://remote.example/a.png');">
      <label for="search-box">搜索</label>
      <input id="search-box" type="text" value="默认词" maxlength="40" readonly>
      <input type="checkbox" checked>
      <a href="https://example.org/docs" onclick="alert(1)">外部文档</a>
    </header>
    <section class="hero">
      <h1>你好 {Forma} &amp; 空间工作台</h1>
      <p>第一段未闭合直接遇到第二段
      <p>第二段内容<br><hr>
      <img src="images/banner.png" alt="主视觉">
      <img src="https://remote.example/photo.jpg" alt="远程图">
      <svg viewbox="0 0 24 24" stroke-width="1.5" stroke-linecap="round">
        <defs><lineargradient id="g1"><stop offset="0%" stop-color="#fff"></stop></lineargradient></defs>
        <path d="M4 12h16" fill-rule="evenodd"></path>
      </svg>
      <form action="/submit">
        <textarea>多行初始文本</textarea>
        <button>立即体验</button>
      </form>
    </section>
    <iframe src="https://evil.example/frame"></iframe>
  </body>
</html>`;

    const result = compileHtmlToReactWork(html, {
      resolveAssetUrl: (rawUrl, kind) => {
        if (kind === 'img' && rawUrl === 'images/banner.png') return 'imported/banner-123.png';
        return null;
      },
    });

    expect(result.title).toBe('星河设计工作室 — 2026');
    assertValidTsx(result.appTsx);

    expect(result.appTsx).toContain('data-spatial-page');
    expect(result.appTsx).toContain('className="forma-imported-page theme-light"');
    expect(result.appTsx).toContain('htmlFor="search-box"');
    expect(result.appTsx).toContain('defaultValue="默认词"');
    expect(result.appTsx).toContain('maxLength="40"');
    expect(result.appTsx).toContain('readOnly');
    expect(result.appTsx).toContain('defaultChecked');
    expect(result.appTsx).not.toContain('onclick');
    expect(result.appTsx).not.toContain('window.evil');
    expect(result.appTsx).not.toContain('<iframe');
    expect(result.appTsx).toContain('href="#external-link"');
    expect(result.appTsx).toContain('&#123;Forma&#125;');
    expect(result.appTsx).toContain('${import.meta.env.BASE_URL}imported/banner-123.png');
    expect(result.appTsx).toContain('data:image/svg+xml;utf8,');
    expect(result.appTsx).toContain('viewBox="0 0 24 24"');
    expect(result.appTsx).toContain('strokeWidth="1.5"');
    expect(result.appTsx).toContain('<linearGradient');
    expect(result.appTsx).toContain('stopColor="#fff"');
    expect(result.appTsx).toContain('onSubmit={event => event.preventDefault()}');
    expect(result.appTsx).toContain('<button type="button">立即体验</button>');

    expect(result.styleCss).not.toContain('fonts.googleapis.com');
    expect(result.styleCss).not.toContain('cdn.example.com');
  });

  it('sanitizes CSS @import and remote url() tokens while preserving resolved local relative assets', () => {
    const css = `
      @import "https://example.com/reset.css";
      .card { background: url("../img/card.png") no-repeat center; }
      .remote { background-image: url(https://example.com/pic.webp); }
    `;
    const cleaned = sanitizeImportedCss(css, raw => (raw.includes('card.png') ? './imported/card.png' : null));
    expect(cleaned).not.toContain('@import');
    expect(cleaned).toContain('url("./imported/card.png")');
    expect(cleaned).not.toContain('example.com');
  });
});
