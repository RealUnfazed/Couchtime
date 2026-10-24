'use strict';

const mongoose = require('mongoose');
const config = require('./config');

// Cache the connection on `global` so serverless invocations that reuse a warm
// container (and hot reloads in dev) share one connection instead of opening many.
const cache = global.__couchtimeMongo || (global.__couchtimeMongo = { conn: null, promise: null });

async function connectDB() {
  if (cache.conn && mongoose.connection.readyState === 1) return cache.conn;
  if (!cache.promise) {
    cache.promise = mongoose
      .connect(config.mongoUri, {
        serverSelectionTimeoutMS: 8000,
        maxPoolSize: config.isVercel ? 5 : 20,
        bufferCommands: false,
      })
      .then((m) => m);
  }
  try {
    cache.conn = await cache.promise;
  } catch (err) {
    cache.promise = null;
    cache.conn = null;
    throw err;
  }
  return cache.conn;
}

module.exports = { connectDB };
