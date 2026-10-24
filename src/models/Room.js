'use strict';

const mongoose = require('mongoose');

const playlistItem = new mongoose.Schema(
  {
    id: { type: String, required: true },
    provider: { type: String, required: true },
    mediaId: { type: String, required: true },
    url: { type: String, required: true },
    title: { type: String, default: '' },
    addedBy: { type: String, default: '' },
    addedById: { type: String, default: '' },
    addedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const roomSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true }, // short code used in the invite link
    name: { type: String, required: true, maxlength: 40 },
    owner: {
      id: { type: String, required: true, index: true }, // "u:<userId>" or "g:<guestId>"
      name: { type: String, default: '' },
    },
    // Who may press play/pause/seek/change the video.
    control: { type: String, enum: ['everyone', 'mods', 'host'], default: 'everyone' },
    mods: { type: [String], default: [] },
    banned: { type: [String], default: [] },
    passwordHash: { type: String, default: '' },
    permanent: { type: Boolean, default: false },

    // The shared player. Position is an anchor: when `playing`, the real position is
    // position + (now - updatedAt) * rate. Everybody computes the same number from this.
    state: {
      provider: { type: String, default: '' }, // youtube | vimeo | file | '' (nothing loaded)
      mediaId: { type: String, default: '' },
      url: { type: String, default: '' },
      title: { type: String, default: '' },
      playing: { type: Boolean, default: false },
      position: { type: Number, default: 0 },
      rate: { type: Number, default: 1 },
      updatedAt: { type: Date, default: Date.now },
      version: { type: Number, default: 0 },
    },
    playlist: { type: [playlistItem], default: [] },

    // Temporary rooms carry an expiry date that MongoDB's TTL monitor enforces. Permanent rooms have none.
    expireAt: { type: Date, default: undefined },
  },
  { timestamps: true }
);

roomSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.Room || mongoose.model('Room', roomSchema);
