'use strict';

// Long-running entry point: your laptop, a VPS, Render, Railway, Fly... anywhere Node can stay running.
// On Vercel this file is not used; Vercel runs api/index.js instead.

const http = require('http');
const config = require('./src/config');
const app = require('./src/app');
const realtime = require('./src/realtime');
const { connectDB } = require('./src/db');
const User = require('./src/models/User');
const Room = require('./src/models/Room');
const Message = require('./src/models/Message');

async function main() {
  for (const p of config.problems()) console.warn(`[config] ${p}`);

  try {
    await connectDB();
    await Promise.all([User.init(), Room.init(), Message.init()]); // make sure unique + TTL indexes exist
    console.log('[db] connected');
  } catch (err) {
    console.error(`[db] could not connect to ${config.mongoUri.replace(/\/\/[^@]*@/, '//***@')}`);
    console.error(`     ${err.message}`);
    console.error('     Start MongoDB (docker compose up -d) or set MONGODB_URI in .env.');
    process.exit(1);
  }

  const server = http.createServer(app);
  realtime.attach(server);

  server.listen(config.port, () => {
    console.log(`[app] ${config.appName} running at http://localhost:${config.port}  (realtime: ${config.realtime.driver})`);
  });

  const stop = () => server.close(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main();
