'use strict';

const mongoose = require('mongoose');
const config = require('../config');

const messageSchema = new mongoose.Schema({
  room: { type: String, required: true },
  author: {
    id: String,
    name: String,
    color: String,
  },
  text: { type: String, required: true, maxlength: 2000 },
  // Chat history cleans itself up so a free 512 MB database never fills up.
  createdAt: { type: Date, default: Date.now, expires: config.limits.chatKeepDays * 24 * 3600 },
});

messageSchema.index({ room: 1, createdAt: -1 });

module.exports = mongoose.models.Message || mongoose.model('Message', messageSchema);
