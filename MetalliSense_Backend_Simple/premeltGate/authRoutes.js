/**
 * Express Authentication Routes (/api/v2/auth).
 * Handles login, session issuance, CSRF tokens, user profile, re-authentication, and logout.
 */
const express = require('express');
const sec = require('./security');
const { requireAuth, requireHuman } = require('./authMiddleware');

const router = express.Router();

const isProduction = process.env.NODE_ENV === 'production';

// Cookie options
const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax',
  secure: isProduction,
  path: '/',
  maxAge: 24 * 3600 * 1000 // 24 hours
};

const CSRF_COOKIE_OPTIONS = {
  httpOnly: false, // Accessible to JavaScript Axios interceptors
  sameSite: 'lax',
  secure: isProduction,
  path: '/',
  maxAge: 24 * 3600 * 1000
};

/**
 * POST /api/v2/auth/login
 */
router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const ip = req.ip || req.socket.remoteAddress;
  const userAgent = req.headers['user-agent'] || null;

  if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({
      status: 'fail',
      code: 'INVALID_CREDENTIALS_FORMAT',
      message: 'Username and password are required'
    });
  }

  const user = sec.getUserByUsername(username);

  // Check account lockout
  if (user && user.locked_until && new Date(user.locked_until) > new Date()) {
    const remainingSec = Math.ceil((new Date(user.locked_until).getTime() - Date.now()) / 1000);
    return res.status(429).json({
      status: 'fail',
      code: 'ACCOUNT_LOCKED',
      message: `Account is temporarily locked due to excessive failed attempts. Please retry in ${remainingSec} seconds.`
    });
  }

  // Check disabled status
  if (user && user.is_enabled === 0) {
    return res.status(403).json({
      status: 'fail',
      code: 'ACCOUNT_DISABLED',
      message: 'This account has been disabled. Please contact your system administrator.'
    });
  }

  // Constant-time password verification
  const isValid = user ? sec.verifyPassword(password, user.password_hash) : false;

  if (!isValid) {
    const failureState = sec.recordFailedLogin(username, ip);
    if (failureState.locked) {
      return res.status(429).json({
        status: 'fail',
        code: 'ACCOUNT_LOCKED',
        message: 'Account locked due to excessive failed attempts. Please try again after 15 minutes.'
      });
    }
    // Generic error to prevent username enumeration
    return res.status(401).json({
      status: 'fail',
      code: 'INVALID_CREDENTIALS',
      message: 'Invalid username or password.'
    });
  }

  // Password correct: reset failed login counter & create session
  sec.resetFailedLogin(user.user_id, ip);
  const sessionData = sec.createSession(user.user_id, ip, userAgent);

  // Set HttpOnly session cookie and accessible CSRF cookie
  res.cookie('metallisense_session', sessionData.sessionId, SESSION_COOKIE_OPTIONS);
  res.cookie('metallisense_csrf', sessionData.csrfToken, CSRF_COOKIE_OPTIONS);

  // Cache-Control headers to prevent caching sensitive auth responses
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  res.json({
    status: 'success',
    data: {
      user: sessionData.user,
      csrfToken: sessionData.csrfToken,
      expiresAt: sessionData.expiresAt
    }
  });
});

/**
 * POST /api/v2/auth/logout
 */
router.post('/logout', (req, res) => {
  const sessionId = req.cookies?.metallisense_session || (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7).trim() : null);
  const ip = req.ip || req.socket.remoteAddress;

  if (sessionId) {
    sec.revokeSession(sessionId, ip);
  }

  res.clearCookie('metallisense_session', { path: '/' });
  res.clearCookie('metallisense_csrf', { path: '/' });

  res.json({
    status: 'success',
    data: { loggedOut: true }
  });
});

/**
 * GET /api/v2/auth/me
 */
router.get('/me', requireAuth, (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  if (req.user) {
    return res.json({
      status: 'success',
      data: {
        principalType: 'HUMAN',
        user: req.user
      }
    });
  }
  if (req.service) {
    return res.json({
      status: 'success',
      data: {
        principalType: 'SERVICE',
        service: req.service
      }
    });
  }
});

/**
 * POST /api/v2/auth/reauth
 * Used for high-security administrative operations (like development demo reset)
 */
router.post('/reauth', requireHuman, (req, res) => {
  const { password } = req.body || {};
  if (!password) {
    return res.status(400).json({ status: 'fail', message: 'Password is required for re-authentication' });
  }

  const user = sec.getUserById(req.user.userId);
  if (!user || !sec.verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ status: 'fail', code: 'REAUTH_FAILED', message: 'Re-authentication password incorrect' });
  }

  res.json({
    status: 'success',
    data: {
      reauthenticated: true,
      timestamp: new Date().toISOString()
    }
  });
});

/**
 * GET /api/v2/auth/csrf
 */
router.get('/csrf', (req, res) => {
  const csrfToken = req.cookies?.metallisense_csrf || sec.generateToken(16);
  res.cookie('metallisense_csrf', csrfToken, CSRF_COOKIE_OPTIONS);
  res.json({ status: 'success', data: { csrfToken } });
});

module.exports = router;
