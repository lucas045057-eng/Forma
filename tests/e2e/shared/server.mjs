/**
 * 起 API + 预览源两个监听（与 apps/server/src/index.ts 同一条路径）。
 * `previewPort` 为 0/未设置时只起 API（沙箱后端用，避免与主后端抢 5175）。
 */
export async function listenWithPreview({ app, work, apiPort, previewPort, mainPort = 5174, studioOrigin = 'http://127.0.0.1:5173' }) {
  let preview = null;
  if (previewPort) {
    const { createPreviewOrigin } = await import('../../../apps/server/src/work/preview-origin.ts');
    preview = createPreviewOrigin(work.previews, { mainPort, studioOrigin });
    const sockets = new Set();
    preview.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    app.addHook('preClose', async () => {
      for (const socket of sockets) socket.destroy();
      preview.closeAllConnections();
      await new Promise((resolve) => preview.close(() => resolve()));
    });
    await new Promise((resolve, reject) => {
      preview.once('error', reject);
      preview.listen(previewPort, '127.0.0.1', resolve);
    });
  }
  await app.listen({ port: apiPort, host: '127.0.0.1' });
  return { preview };
}
