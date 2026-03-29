import { SyncServer } from './server.js';

const port = parseInt(process.argv[2] ?? '3000', 10);
const server = new SyncServer({ port });

server.start().then(() => {
  console.log(`Local-First sync server running on ws://localhost:${port}`);
});

process.on('SIGINT', () => {
  server.stop().then(() => {
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  server.stop().then(() => {
    process.exit(0);
  });
});
