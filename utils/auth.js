const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuid } = require('uuid');

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.warn('⚠️ JWT_SECRET n’est pas configuré.');
}

const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

function newId() {
  return uuid();
}

async function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

async function verifyPassword(password, passwordHash) {
  return bcrypt.compare(password, passwordHash);
}

function signToken(user) {
  if (!JWT_SECRET) {
    throw new Error('JWT_SECRET n’est pas configuré.');
  }

  return jwt.sign(
    {
      sub: user.id,
      email: user.email
    },
    JWT_SECRET,
    {
      expiresIn: JWT_EXPIRES_IN
    }
  );
}

function verifyToken(token) {
  if (!JWT_SECRET) {
    throw new Error('JWT_SECRET n’est pas configuré.');
  }

  return jwt.verify(token, JWT_SECRET);
}

function generateVerificationCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

module.exports = {
  newId,
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
  generateVerificationCode
};
