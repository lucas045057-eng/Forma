export const previewOrigin = new URL(import.meta.env.VITE_PREVIEW_ORIGIN ?? 'http://127.0.0.1:5175').origin;
export function previewUrl(path: string) {
  const url = new URL(path, previewOrigin);
  if (url.origin !== previewOrigin || !url.pathname.startsWith('/preview/')) throw new Error('非法预览地址');
  url.searchParams.set('studioOrigin', window.location.origin);
  return url.href;
}
