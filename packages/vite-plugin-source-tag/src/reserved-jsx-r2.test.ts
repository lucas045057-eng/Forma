import { parseSync } from '@babel/core';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { tagSource } from './index';

/**
 * Codex 审查 R2 的回归用例（docs/reports/M0-B-review.md#R2）：
 * `data-src` / `data-cid` 里如果本身是 JSX 表达式（`data-src={<span/>}`），
 * 插件删除这个保留属性后，必须跳过该属性子树里的注入，否则外层元素会被
 * 标成属性内部那个元素的源码位置。
 *
 * 修复前这两条会失败，用 `it.fails` 标成「已知待修」：修复后它们会变成
 * 意外通过并让 `pnpm test` 失败，提醒把 it.fails 改回 it。
 * 这里只新增测试文件，不改实现。
 */

const root = path.resolve('fixture');
const transform = (code: string) => tagSource(code, path.join(root, 'src', 'Page.tsx'), root)!.code;
const countOf = (code: string, needle: string) => code.split(needle).length - 1;
const parses = (code: string) => {
  expect(() => parseSync(code, {
    babelrc: false,
    configFile: false,
    parserOpts: { sourceType: 'module', plugins: ['jsx', 'typescript'] },
  })).not.toThrow();
};

describe('保留属性内含 JSX（R2）', () => {
  it.fails('data-src={<span/>} 时外层 <div> 必须标记自己的位置', () => {
    // const Page=()=> 之后就是外层 <div> 的第 17 列
    const output = transform('const Page=()=> <div data-src={<span/>}/>;');
    expect(output).toContain('data-src={"src/Page.tsx:1:17"}');
    expect(countOf(output, 'data-src='), '只应留下外层一个标记').toBe(1);
    expect(countOf(output, 'data-cid='), '只应留下外层一个标记').toBe(1);
    parses(output);
  });

  it.fails('data-cid={<span/>} 时同样不得把外层标成内层', () => {
    const output = transform('const Page=()=> <section data-cid={<i/>}/>;');
    expect(output).toContain('data-src={"src/Page.tsx:1:17"}');
    expect(countOf(output, 'data-src=')).toBe(1);
    expect(countOf(output, 'data-cid=')).toBe(1);
    parses(output);
  });

  it('spread 与字符串保留属性的既有行为不变（对照）', () => {
    const output = transform('const Page=()=> <div data-src="old" {...props} data-cid="old"/>;');
    expect(countOf(output, 'data-src=')).toBe(1);
    expect(countOf(output, 'data-cid=')).toBe(1);
    expect(output).toContain('data-src={"src/Page.tsx:1:17"}');
    expect(output).not.toContain('old');
    parses(output);
  });
});
