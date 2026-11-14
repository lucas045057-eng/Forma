await import('../apps/server/dist/app.js');
await import('../apps/server/dist/checks/worker.js');
await import('../apps/server/dist/checks/routes.js');
console.log('Native compiled app/worker/routes imports passed; no service instantiated');
