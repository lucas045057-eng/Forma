import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { lstat, open, realpath } from 'node:fs/promises';
import { randomInt } from 'node:crypto';
import path from 'node:path';

const inside = (root: string, file: string) => { const rel = path.relative(root, file); return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)); };
const mime: Record<string,string> = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml','.glb':'model/gltf-binary','.gltf':'model/gltf+json','.woff2':'font/woff2','.ico':'image/x-icon' };
export interface StaticOrigin { url: string; close(): Promise<void> }
export async function startStaticOrigin(buildRoot: string): Promise<StaticOrigin> {
  const root = path.join(buildRoot, 'dist');
  if ((await lstat(root)).isSymbolicLink() || path.relative(root, await realpath(root)) !== '') throw new Error('STATIC_PATH_DENIED');
  let server: Server | undefined;
  let port = 0;
  const fail = (response: ServerResponse, code: number) => { response.writeHead(code, {'cache-control':'no-store','x-content-type-options':'nosniff'}); response.end(); };
  async function handle(request: IncomingMessage, response: ServerResponse) {
    if (request.headers.host !== '127.0.0.1:' + port) return fail(response,403);
    if (!['GET','HEAD'].includes(request.method ?? '')) return fail(response,405);
    let pathname: string;
    try { pathname = decodeURIComponent((request.url ?? '').split('?')[0]); } catch { return fail(response,400); }
    if (!pathname.startsWith('/') || pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').includes('..')) return fail(response,403);
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!inside(root,file)) return fail(response,403);
    const type = mime[path.extname(file).toLowerCase()];
    if (!type) return fail(response,404);
    try {
      let current = root;
      for (const part of path.relative(root,file).split(path.sep)) {
        current = path.join(current,part);
        if ((await lstat(current)).isSymbolicLink()) return fail(response,403);
      }
      if (!inside(root,await realpath(file))) return fail(response,403);
      const handle = await open(file,'r');
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 50*1024*1024) return fail(response,403);
        // Read through the opened handle. The compiler has finished before this origin starts.
        const data = await handle.readFile();
        const after = await lstat(file);
        if (after.isSymbolicLink() || after.ino !== stat.ino || after.dev !== stat.dev) return fail(response,403);
        response.writeHead(200,{'content-type':type,'content-length':data.length,'cache-control':'no-store','x-content-type-options':'nosniff',
          'content-security-policy': "worker-src 'none'"});
        response.end(request.method === 'HEAD' ? undefined : data);
      } finally { await handle.close(); }
    } catch(error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') fail(response,404);
      else fail(response,403);
    }
  }
  let lastError: unknown;
  for (let attempt=0;attempt<32;attempt++) {
    port = randomInt(20000,65536);
    const candidate = createServer((req,res)=>{void handle(req,res).catch(()=>fail(res,500));});
    try {
      await new Promise<void>((resolve,reject)=>{candidate.once('error',reject);candidate.listen(port,'127.0.0.1',()=>{candidate.removeListener('error',reject);resolve();});});
      server=candidate; break;
    } catch(error) {
      lastError=error;
      if (candidate.listening) await new Promise<void>((resolve,reject)=>candidate.close(e=>e?reject(e):resolve()));
      const code=(error as NodeJS.ErrnoException).code;
      if (code!=='EADDRINUSE' && !(process.platform==='win32' && code==='EACCES')) throw error;
    }
  }
  if (!server) throw new Error('STATIC_PORT_UNAVAILABLE',{cause:lastError});
  const owned=server;
  let closing: Promise<void> | undefined;
  return {url:'http://127.0.0.1:'+port+'/',close(){
    closing ??= (async()=>{owned.closeAllConnections();await new Promise<void>((resolve,reject)=>owned.close(error=>error?reject(error):resolve()));})();
    return closing;
  }};
}

