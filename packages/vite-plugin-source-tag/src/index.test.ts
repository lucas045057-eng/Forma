import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import sourceTag, { recoverNonEmptySource, tagSource } from './index';

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
  it('does not traverse or edit JSX inside removed reserved attributes', () => {
    for (const code of ['const Page=()=> <div data-src={<span/>}/>;', 'const Page=()=> <div data-cid={<b/>}>content</div>;']) {
      const result = transform(code);
      expect(result).toContain(`data-src={"src/Page.tsx:1:${code.indexOf('<div') + 1}"}`);
      expect(result.match(/data-src=/g)).toHaveLength(1);
      expect(result).not.toContain('<span');
      expect(result).not.toContain('b');
      expect(result).toContain('data-cid={"Page"}');
    }
  });
  it('does not treat a capitalized JSX value as a component', () => {
    const result = transform('const Page=()=>{const Heading=<h1/>; return Heading;}');
    expect(result).toContain('data-cid={"Page"}');
    expect(result).not.toContain('data-cid={"Heading"}');
  });
  it('keeps named function expressions, top-level helpers and wrapped components', () => {
    const result = transform('const Page = function PageView() { return <main/> }; const Panel = memo(forwardRef(function PanelView() { return <section/> }));');
    expect(result).toContain('data-cid={"Page"}');
    expect(result).toContain('data-cid={"Panel"}');
  });
  it('uses UTF-16 columns and handles multiline opening tags', () => {
    const code = 'const Page = () => <>香🌿<img\n alt="香"\n /></>;';
    expect(transform(code)).toContain(`src/Page.tsx:1:${code.indexOf('<img') + 1}`);
  });
  it('only enables serve and excludes sources outside the root', () => {
    expect(sourceTag().apply).toBe('serve');
    expect(tagSource('const A = () => <div/>', path.resolve('elsewhere.tsx'), root)).toBeNull();
  });
  it('recovers from a transient 0-byte read during concurrent Windows git updates and refuses to cache empty TSX', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'source-tag-race-'));
    try {
      const file = path.join(dir, 'App.tsx');
      await writeFile(file, '');
      setTimeout(() => { void writeFile(file, 'export default function App() { return <main/>; }\n'); }, 20);
      const plugin = sourceTag();
      (plugin.configResolved as (config: { root: string }) => void)({ root: dir });
      const transformFn = plugin.transform as (code: string, id: string) => Promise<{ code: string } | null>;
      const recovered = await transformFn('', `${file}?t=123`);
      expect(recovered?.code).toContain('export default function App()');
      expect(recovered?.code).toContain('data-src={"App.tsx:1:40"}');

      const emptyFile = path.join(dir, 'Empty.tsx');
      await writeFile(emptyFile, '');
      await expect(recoverNonEmptySource('', emptyFile, [5, 5])).rejects.toThrow(/Refusing to cache empty JSX\/TSX module/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
