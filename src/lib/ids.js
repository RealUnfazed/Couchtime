'use strict';

const crypto = require('crypto');

// No 0/o/1/l/i so codes survive being read out loud.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

function randomId(len = 8) {
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return out;
}

const uuid = () => crypto.randomUUID();

const COLORS = ['#ff7a8a', '#ffb547', '#9be564', '#4fd1c5', '#63b3ff', '#a78bfa', '#f38bd8', '#ff9966', '#7bdff2', '#c3e88d'];
const randomColor = () => COLORS[crypto.randomInt(COLORS.length)];
const isColor = (c) => typeof c === 'string' && COLORS.includes(c);

function cleanName(input, max = 24) {
  return String(input || '')
    .replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

module.exports = { randomId, uuid, COLORS, randomColor, isColor, cleanName };
