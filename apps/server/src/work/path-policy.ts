/**
 * The work tree allow-list shared by staging, the committed-tree audit and the index check.
 * Kept in one place so a node audit and an index check cannot drift apart; the rules themselves
 * are unchanged from the previous private copy.
 */
export function permittedWorkPath(file: string): boolean {
  if (file.split('/').some(part => /^(?:\.|.*(?:secret|credential|private.?key|backup))/i.test(part) || /\.(?:pem|key|crt|p12|pfx|bak|tmp|old|orig)$/i.test(part))) return false;
  return /^(?:src|public)\/[a-z0-9_./-]+$/i.test(file) || ['index.html', 'package.json', 'vite.config.ts', 'tsconfig.json'].includes(file);
}
