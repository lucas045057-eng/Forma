import path from 'node:path';
import { describe, expect, it } from 'vitest';
import sourceTag, { tagSource } from './index';

const root = path.resolve('fixture');
const transform = (code: string) => tagSource(code, path.join(root, 'src', 'Page.tsx'), root)!.code;
describe('source tags', () => {
  it('uses original opening angle bracket locations, including CRLF and Unicode', () => {
    const code = 'const Page = () => (\r\n  <div title="香薰">\r\n    <span />\r\n  </div>\r\n);';
    const result = transform(code);
    expect(result).toContain('data-src={"src/Page.tsx:2:3"}');
    expect(result).toContain('data-src={"src/Page.tsx:3:5"}');
    expect(result.match(/data-cid={"Page"}/g)).toHaveLength(2);
  });
  it('skips component tags and keeps the component across map callbacks', () => {
    const result = transform('function Page() { return <><Button/><UI.Icon/>{[1,2].map(x => <li>{x}</li>)}</>; }');
    expect(result.match(/data-src=/g)).toHaveLength(1);
    expect(result).toContain('data-cid={"Page"}');
  });
  it('selects the nearest named component and supports class and wrapped components', () => {
    const result = transform('const Outer = () => { const Inner = memo(() => <button/>); return <main/> }; class Card extends React.Component { render() { return <article/> } }');
    for (const name of ['Inner', 'Outer', 'Card']) expect(result).toContain(`data-cid={"${name}"}`);
  });
  it('replaces reserved attributes and appends after spread props', () => {
    const result = transform('const Button = () => <button data-src="wrong" {...props} data-cid="wrong"/>;');
    expect(result).not.toContain('wrong');
    expect(result.indexOf('data-src')).toBeGreaterThan(result.indexOf('{...props}'));
    expect(result.match(/data-src=/g)).toHaveLength(1);
  });
  it('uses UTF-16 columns and handles multiline opening tags', () => {
    const code = 'const Page = () => <>香🌿<img\n alt="香"\n /></>;';
    expect(transform(code)).toContain(`src/Page.tsx:1:${code.indexOf('<img') + 1}`);
  });
  it('only enables serve and excludes sources outside the root', () => {
    expect(sourceTag().apply).toBe('serve');
    expect(tagSource('const A = () => <div/>', path.resolve('elsewhere.tsx'), root)).toBeNull();
  });
});
