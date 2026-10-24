'use strict';

const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, trim: true, maxlength: 24 },
    usernameLower: { type: String, required: true, unique: true, index: true },
    displayName: { type: String, required: true, trim: true, maxlength: 24 },
    passwordHash: { type: String, required: true },
    color: { type: String, default: '#ffb547' },
  },
  { timestamps: true }
);

module.exports = mongoose.models.User || mongoose.model('User', userSchema);
