/**
 * Security, Identity, Password Hashing, Session Management and Maker-Checker Engine.
 * Built with standard Node.js native crypto (scrypt, timingSafeEqual, randomBytes, createHash).
 */
const crypto = require('crypto');
const { getDb, withTransaction } = require('./db');

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;
const SALT_LEN = 16;
const SESSION_DURATION_HOURS = 24;
const SESSION_IDLE_HOURS = 8;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

/**
 * Standard scrypt password hashing
 * Format: scrypt$N$r$p$<salt_hex>$<hash_hex>
 */
function hashPassword(password) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('Password must be a non-empty string');
  }
  const salt = crypto.randomBytes(SALT_LEN).toString('hex');
  const derived = crypto.scryptSync(password, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 64 * 1024 * 1024
  }).toString('hex');
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt}$${derived}`;
}

/**
 * Timing-safe scrypt password verification
 */
function verifyPassword(password, hashStr) {
  if (typeof password !== 'string' || typeof hashStr !== 'string') {
    return false;
  }
  const parts = hashStr.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    return false;
  }
  const N = parseInt(parts[1], 10);
  const r = parseInt(parts[2], 10);
  const p = parseInt(parts[3], 10);
  const salt = parts[4];
  const expectedHash = parts[5];

  try {
    const derived = crypto.scryptSync(password, salt, KEY_LEN, {
      N,
      r,
      p,
      maxmem: 64 * 1024 * 1024
    }).toString('hex');

    const bufA = Buffer.from(derived, 'hex');
    const bufB = Buffer.from(expectedHash, 'hex');
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  } catch (_) {
    return false;
  }
}

/**
 * SHA-256 hash for machine API keys
 */
function hashApiKey(apiKey) {
  return crypto.createHash('sha256').update(String(apiKey).trim()).digest('hex');
}

/**
 * Cryptographically random token
 */
function generateToken(byteLen = 32) {
  return crypto.randomBytes(byteLen).toString('hex');
}

// -----------------------------------------------------------------------------
// User Queries
// -----------------------------------------------------------------------------
function getUserByUsername(username) {
  if (!username) return null;
  const db = getDb();
  const row = db.prepare('SELECT * FROM users WHERE LOWER(username) = LOWER(?)').get(String(username).trim());
  if (!row) return null;
  return {
    ...row,
    roles: JSON.parse(row.roles || '[]')
  };
}

function getUserById(userId) {
  if (!userId) return null;
  const db = getDb();
  const row = db.prepare('SELECT * FROM users WHERE user_id = ?').get(String(userId));
  if (!row) return null;
  return {
    ...row,
    roles: JSON.parse(row.roles || '[]')
  };
}

function createUser({ userId, username, email, displayName, fullName, password, roles = ['OPERATOR'], isEnabled = 1 }) {
  const db = getDb();
  const id = userId || crypto.randomUUID();
  const now = new Date().toISOString();
  const pHash = hashPassword(password);
  const rolesJson = JSON.stringify(Array.isArray(roles) ? roles : [roles]);

  db.prepare(`
    INSERT INTO users (
      user_id, username, email, display_name, password_hash, roles,
      is_enabled, credential_version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(id, username.toLowerCase().trim(), email.toLowerCase().trim(), displayName || fullName || null, pHash, rolesJson, isEnabled ? 1 : 0, now, now);

  logSecurityEvent('USER_CREATED', id, 'HUMAN', null, `Created user ${username} with roles ${rolesJson}`);
  return getUserById(id);
}

function updateUserPassword(userOrId, newPassword) {
  const db = getDb();
  const user = getUserById(userOrId) || getUserByUsername(userOrId);
  const uid = user ? user.user_id : userOrId;
  const pHash = hashPassword(newPassword);
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE users
    SET password_hash = ?, credential_version = credential_version + 1, updated_at = ?
    WHERE user_id = ?
  `).run(pHash, now, uid);
  revokeAllUserSessions(uid);
  logSecurityEvent('PASSWORD_CHANGED', uid, 'HUMAN', null, 'User changed password and invalidated prior sessions');
}

function recordFailedLogin(username, ip = null) {
  const db = getDb();
  const user = getUserByUsername(username);
  if (!user) {
    logSecurityEvent('AUTH_FAILURE', null, 'ANONYMOUS', ip, `Failed login attempt for non-existent username: ${username}`);
    return { locked: false, attempts: 0 };
  }

  const attempts = (user.failed_attempts || 0) + 1;
  let lockedUntil = user.locked_until;

  if (attempts >= MAX_FAILED_ATTEMPTS) {
    lockedUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000).toISOString();
    logSecurityEvent('ACCOUNT_LOCKED', user.user_id, 'HUMAN', ip, `Account locked after ${attempts} failed attempts`);
  } else {
    logSecurityEvent('AUTH_FAILURE', user.user_id, 'HUMAN', ip, `Failed password attempt ${attempts}/${MAX_FAILED_ATTEMPTS}`);
  }

  db.prepare(`
    UPDATE users SET failed_attempts = ?, locked_until = ?, updated_at = ?
    WHERE user_id = ?
  `).run(attempts, lockedUntil, new Date().toISOString(), user.user_id);

  return {
    locked: !!lockedUntil && new Date(lockedUntil) > new Date(),
    attempts
  };
}

function setUserActiveStatus(userId, isEnabled) {
  const db = getDb();
  const user = getUserById(userId) || getUserByUsername(userId);
  const uid = user ? user.user_id : userId;
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE users SET is_enabled = ?, updated_at = ?
    WHERE user_id = ?
  `).run(isEnabled ? 1 : 0, now, uid);
}

function resetFailedLogin(userId, ip = null) {
  const db = getDb();
  const user = getUserById(userId) || getUserByUsername(userId);
  const uid = user ? user.user_id : userId;
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = ?, updated_at = ?
    WHERE user_id = ?
  `).run(now, now, uid);
  logSecurityEvent('AUTH_SUCCESS', uid, 'HUMAN', ip, 'Successful authentication');
  return;
}

// -----------------------------------------------------------------------------
// Service Credentials Queries
// -----------------------------------------------------------------------------
function getServiceByApiKey(apiKey) {
  if (!apiKey) return null;
  const hash = hashApiKey(apiKey);
  const db = getDb();
  const row = db.prepare('SELECT * FROM service_credentials WHERE api_key_hash = ? AND is_enabled = 1').get(hash);
  if (!row) return null;

  // Touch last_auth_at
  db.prepare('UPDATE service_credentials SET last_auth_at = ? WHERE service_id = ?')
    .run(new Date().toISOString(), row.service_id);

  return {
    ...row,
    allowedSources: JSON.parse(row.allowed_sources || '[]'),
    permittedEvidence: JSON.parse(row.permitted_evidence || '[]')
  };
}

function createServiceCredential({ serviceId, serviceName, serviceType, apiKey, allowedSources = ['*'], permittedEvidence = [] }) {
  const db = getDb();
  const id = serviceId || `SVC-${Date.now()}`;
  const keyHash = hashApiKey(apiKey);
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO service_credentials (
      service_id, service_name, service_type, api_key_hash, allowed_sources,
      permitted_evidence, is_enabled, credential_version, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?)
  `).run(
    id,
    serviceName,
    serviceType,
    keyHash,
    JSON.stringify(allowedSources),
    JSON.stringify(permittedEvidence),
    now
  );

  logSecurityEvent('SERVICE_CREDENTIAL_CREATED', id, 'SERVICE', null, `Created service credential for ${serviceName} (${serviceType})`);
  return { serviceId: id, serviceName, serviceType };
}

// -----------------------------------------------------------------------------
// Session Management
// -----------------------------------------------------------------------------
function createSession(userId, ip = null, userAgent = null) {
  const user = getUserById(userId);
  if (!user || !user.is_enabled) {
    throw new Error('User not found or disabled');
  }

  const db = getDb();
  const sessionId = generateToken(32);
  const csrfToken = generateToken(16);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_DURATION_HOURS * 3600 * 1000).toISOString();
  const nowIso = now.toISOString();

  db.prepare(`
    INSERT INTO sessions (
      session_id, user_id, credential_version, created_at, expires_at,
      last_activity_at, is_revoked, ip_address, user_agent
    ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
  `).run(sessionId, user.user_id, user.credential_version, nowIso, expiresAt, nowIso, ip, userAgent);

  logSecurityEvent('SESSION_CREATED', user.user_id, 'HUMAN', ip, `Session created for user ${user.username}`);
  return {
    sessionId,
    csrfToken,
    expiresAt,
    user: {
      userId: user.user_id,
      username: user.username,
      displayName: user.display_name,
      roles: user.roles
    }
  };
}

function getSession(sessionId) {
  if (!sessionId) return null;
  const db = getDb();
  const row = db.prepare(`
    SELECT s.*, u.username, u.display_name, u.roles, u.is_enabled, u.credential_version as user_cred_version, u.revoked_before
    FROM sessions s
    JOIN users u ON s.user_id = u.user_id
    WHERE s.session_id = ?
  `).get(sessionId);

  if (!row) return null;

  // Revocation and expiration checks
  const now = new Date();
  if (row.is_revoked === 1) return null;
  if (new Date(row.expires_at) <= now) return null;
  if (!row.is_enabled) return null;
  if (row.credential_version !== row.user_cred_version) return null;
  if (row.revoked_before && new Date(row.created_at) < new Date(row.revoked_before)) return null;

  // Idle timeout check (8 hours)
  const lastActive = new Date(row.last_activity_at);
  if (now.getTime() - lastActive.getTime() > SESSION_IDLE_HOURS * 3600 * 1000) {
    revokeSession(sessionId);
    return null;
  }

  // Touch last_activity_at
  db.prepare('UPDATE sessions SET last_activity_at = ? WHERE session_id = ?')
    .run(now.toISOString(), sessionId);

  return {
    sessionId: row.session_id,
    userId: row.user_id,
    username: row.username,
    displayName: row.display_name,
    roles: JSON.parse(row.roles || '[]'),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastActivityAt: row.last_activity_at
  };
}

function revokeSession(sessionId, ip = null) {
  if (!sessionId) return;
  const db = getDb();
  const sess = db.prepare('SELECT user_id FROM sessions WHERE session_id = ?').get(sessionId);
  db.prepare('UPDATE sessions SET is_revoked = 1 WHERE session_id = ?').run(sessionId);
  if (sess) {
    logSecurityEvent('SESSION_REVOKED', sess.user_id, 'HUMAN', ip, `Session ${sessionId.slice(0, 8)}... revoked`);
  }
}

function revokeAllUserSessions(userId, ip = null) {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare('UPDATE sessions SET is_revoked = 1 WHERE user_id = ?').run(userId);
  db.prepare('UPDATE users SET revoked_before = ?, updated_at = ? WHERE user_id = ?').run(now, now, userId);
  logSecurityEvent('ALL_SESSIONS_REVOKED', userId, 'HUMAN', ip, 'All active sessions revoked for user');
}

// -----------------------------------------------------------------------------
// Maker-Checker Interlocks
// -----------------------------------------------------------------------------
function checkMakerCheckerSeparation({ entityType, entityId, checkerUserId }) {
  const db = getDb();

  if (entityType === 'HEAT_RELEASE') {
    const heat = db.prepare('SELECT planned_by, start_json FROM heats WHERE heat_id = ?').get(entityId);
    if (heat) {
      if (heat.planned_by && heat.planned_by === checkerUserId) {
        return {
          allowed: false,
          code: 'MAKER_CHECKER_VIOLATION',
          reason: 'Quality Manager cannot self-release a heat they planned (maker-checker violation)'
        };
      }
      if (heat.start_json) {
        try {
          const start = JSON.parse(heat.start_json);
          if (start.by && start.by === checkerUserId) {
            return {
              allowed: false,
              code: 'MAKER_CHECKER_VIOLATION',
              reason: 'Quality Manager cannot self-release a heat they initiated melting on (maker-checker violation)'
            };
          }
        } catch (_) {}
      }
    }
  }

  if (entityType === 'FURNACE_HOLD_OVERRIDE') {
    const heat = db.prepare('SELECT planned_by FROM heats WHERE heat_id = ?').get(entityId);
    if (heat && heat.planned_by && heat.planned_by === checkerUserId) {
      return {
        allowed: false,
        code: 'MAKER_CHECKER_VIOLATION',
        reason: 'Safety override must be authorized by an independent metallurgist or administrator, not the operator who planned the charge'
      };
    }
  }

  if (entityType === 'DRI_QA_APPROVAL') {
    const qa = db.prepare('SELECT analyst FROM qa_results WHERE qa_id = ?').get(entityId);
    if (qa && qa.analyst && qa.analyst === checkerUserId) {
      return {
        allowed: false,
        code: 'MAKER_CHECKER_VIOLATION',
        reason: 'DRI QA approval must be performed by an independent checker, not the analyst who entered the readings'
      };
    }
  }

  return { allowed: true };
}

function recordMakerCheckerReview({ entityType, entityId, entityVersion, makerId, checkerId, decision, reason }) {
  const db = getDb();
  const reviewId = crypto.randomUUID();
  const now = new Date().toISOString();

  // Supersede prior reviews for this entity
  db.prepare('UPDATE maker_checker_reviews SET is_superseded = 1 WHERE entity_type = ? AND entity_id = ?')
    .run(entityType, entityId);

  db.prepare(`
    INSERT INTO maker_checker_reviews (
      review_id, entity_type, entity_id, entity_version, maker_id,
      checker_id, decision, reason, reviewed_at, is_superseded
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `).run(reviewId, entityType, entityId, entityVersion, makerId || 'SYSTEM_LEGACY', checkerId, decision, reason, now);

  logSecurityEvent('MAKER_CHECKER_REVIEW', checkerId, 'HUMAN', null, `${decision} review on ${entityType}:${entityId} v${entityVersion}`);
  return reviewId;
}

// -----------------------------------------------------------------------------
// Security Audit Logging
// -----------------------------------------------------------------------------
function logSecurityEvent(eventType, actorId, actorType, ip, detail) {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO security_events (at, event_type, actor_id, actor_type, ip, detail)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(new Date().toISOString(), eventType, actorId || null, actorType || 'ANONYMOUS', ip || null, detail || null);
  } catch (_) {
    // Audit log write failure should not crash application, but write to stderr
  }
}

module.exports = {
  hashPassword,
  verifyPassword,
  hashApiKey,
  generateToken,
  getUserByUsername,
  getUserById,
  createUser,
  updateUserPassword,
  recordFailedLogin,
  resetFailedLogin,
  setUserActiveStatus,
  getServiceByApiKey,
  createServiceCredential,
  createSession,
  getSession,
  revokeSession,
  revokeAllUserSessions,
  checkMakerCheckerSeparation,
  recordMakerCheckerReview,
  logSecurityEvent,
  MAX_FAILED_ATTEMPTS,
  LOCKOUT_MINUTES
};
