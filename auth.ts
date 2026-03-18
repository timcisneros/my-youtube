import { Router } from 'express';
import crypto from 'crypto';

const router = Router();

function ensureAuth(req, res, next) {
  if (!req.session.userId) return res.redirect('/auth/login');
  next();
}

router.get('/login', (_req, res) => {
  res.render('login');
});

router.post('/free', (req, res) => {
  req.session.userId = 'local';
  res.redirect('/');
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/auth/login'));
});

// Stream auth tokens — stateless HMAC-signed tokens for stream routes
// Rotates on server restart (which is fine — player page reloads get new tokens)
const STREAM_SECRET = process.env.STREAM_SECRET
  ? Buffer.from(process.env.STREAM_SECRET, 'hex')
  : crypto.randomBytes(32);
const STREAM_TOKEN_TTL = 8 * 60 * 60 * 1000; // 8 hours

function createStreamToken(videoId) {
  const expiry = Date.now() + STREAM_TOKEN_TTL;
  const sig = crypto.createHmac('sha256', STREAM_SECRET)
    .update(videoId + ':' + expiry)
    .digest('hex')
    .slice(0, 16); // truncate — 64 bits is plenty for rate-limited local service
  return expiry + '.' + sig;
}

function validateStreamToken(videoId, token) {
  const dot = token.indexOf('.');
  if (dot === -1) return false;
  const expiry = parseInt(token.slice(0, dot), 10);
  if (isNaN(expiry) || Date.now() > expiry) return false;
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', STREAM_SECRET)
    .update(videoId + ':' + expiry)
    .digest('hex')
    .slice(0, 16);
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

export default router;
export { ensureAuth, createStreamToken, validateStreamToken };
