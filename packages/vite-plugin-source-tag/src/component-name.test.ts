import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { tagSource } from './index';

/**
 * Codex 审查 S3 的回归（docs/reports/M0-B-review.md#S3）：
 * `cid` 只应认「组件」——命名函数/类，或绑定到组件函数/类/包装调用的变量；
 * 保存 JSX 元素的大写变量（`const Heading = <h1/>`）不是组件，不能抢走归属。
 */

const root = path.resolve('fixture');
const transform = (code: string) => tagSource(code, path.join(root, 'src', 'Page.tsx'), root)!.code;
const cids = (code: string) => [...code.matchAll(/data-cid=\{"([^"]+)"\}/g)].map((match) => match[1]);

describe('组件名归属（S3）', () => {
  it('保存 JSX 的大写变量不被当作组件', () => {
    const output = transform('const Page=()=>{const Heading=<h1/>; return Heading;}');
    expect(cids(output)).toEqual(['Page']);
    expect(output).not.toContain('data-cid={"Heading"}');
    expect(output).toContain('data-src={"src/Page.tsx:1:31"}'); // <h1/> 的位置
  });

  it('组件函数/类、memo 与 forwardRef 包装仍然识别', () => {
    const output = transform([
      'const Card = memo(() => <div/>);',
      'const Field = React.forwardRef((_props, ref) => <input ref={ref}/>);',
      'class Panel extends React.Component { render() { return <section/>; } }',
      'function Wrap() { return <Card/>; }',
    ].join('\n'));
    expect(cids(output)).toEqual(['Card', 'Field', 'Panel']);
  });

  it('命名函数表达式与嵌套组件归属最近的组件', () => {
    const output = transform('const Outer = function Named() { const Inner = () => <button/>; return <main/>; };');
    // 文档顺序：先 <button/>（最近的组件是 Inner），再 <main/>（归属 Outer）
    expect(cids(output)).toEqual(['Inner', 'Outer']);
  });
});
