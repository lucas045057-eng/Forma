import { describe, expect, it } from 'vitest';
import { arrayBufferToBase64, collectUploadFiles } from './new-work-presets.ts';

function fakeFile(name: string, webkitRelativePath?: string): File {
  const file = new File(['hello'], name, { type: 'text/plain' });
  if (webkitRelativePath !== undefined) {
    Object.defineProperty(file, 'webkitRelativePath', { value: webkitRelativePath, configurable: true });
  }
  return file;
}

describe('new-work-presets upload helpers', () => {
  it('filters allowed webpage extensions and normalizes relative paths', () => {
    const files = [
      fakeFile('index.html', 'site\\index.html'),
      fakeFile('app.tsx', 'site/src/app.tsx'),
      fakeFile('README.md', 'site/README.md'),
      fakeFile('archive.zip', 'site/archive.zip'),
    ];
    const collected = collectUploadFiles(files);
    expect(collected.map(item => item.relPath)).toEqual(['site/index.html', 'site/src/app.tsx']);
  });

  it('drops node_modules, VCS, build output, and .env files while enforcing the 250-file cap', () => {
    const blocked = [
      fakeFile('a.js', 'site/node_modules/pkg/a.js'),
      fakeFile('config.json', 'site/.git/config.json'),
      fakeFile('bundle.js', 'site/dist/bundle.js'),
      fakeFile('local.js', 'site/.env.local/local.js'),
    ];
    expect(collectUploadFiles(blocked)).toEqual([]);

    const many = Array.from({ length: 260 }, (_, idx) => fakeFile(`p${idx}.html`));
    expect(collectUploadFiles(many)).toHaveLength(250);
  });

  it('encodes binary buffers to standard base64', () => {
    const bytes = new Uint8Array([0x46, 0x6f, 0x72, 0x6d, 0x61]);
    expect(arrayBufferToBase64(bytes.buffer)).toBe('Rm9ybWE=');
  });
});
