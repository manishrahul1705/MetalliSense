/**
 * Express Authentication and Authorization Middleware.
 * Enforces least-privilege RBAC, machine service identity verification, CSRF, and server-owned actor attribution.
 */
const sec = require('./security');

function parseCookies(cookieHeader) {
  const list = {};
  if (!cookieHeader) return list;
  cookieHeader.split(';').forEach((cookie) => {
    const parts = cookie.split('=');
    const key = parts.shift().trim();
    if (!key) return;
    try {
      list[key] = decodeURIComponent(parts.join('='));
    } catch (_) {
      list[key] = parts.join('=');
    }
  });
  return list;
}

/**
 * Parses session cookies or Bearer tokens and attaches req.user / req.service / req.actor
 */
function authenticate(req, res, next) {
  req.cookies = req.cookies || parseCookies(req.headers.cookie);
  const sessionId = req.cookies.metallisense_session;
  const authHeader = req.headers.authorization;

  // 1. Try session cookie first
  if (sessionId) {
    const session = sec.getSession(sessionId);
    if (session) {
      req.user = {
        userId: session.userId,
        username: session.username,
        displayName: session.displayName,
        roles: session.roles,
        sessionId: session.sessionId
      };
      req.actor = {
        id: session.userId,
        type: 'HUMAN',
        displayName: session.displayName,
        roles: session.roles,
        via: 'SESSION_COOKIE'
      };
      return next();
    }
  }

  // 2. Try Bearer token
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();

    // Check if it's a service token
    const svc = sec.getServiceByApiKey(token);
    if (svc) {
      req.service = {
        serviceId: svc.service_id,
        serviceName: svc.service_name,
        serviceType: svc.service_type,
        allowedSources: svc.allowedSources,
        permittedEvidence: svc.permittedEvidence
      };
      req.actor = {
        id: svc.service_id,
        type: 'SERVICE',
        displayName: svc.service_name,
        roles: [svc.service_type],
        via: 'BEARER_TOKEN'
      };
      return next();
    }

    // Check if it's a user session token passed via Authorization header
    const userSession = sec.getSession(token);
    if (userSession) {
      req.user = {
        userId: userSession.userId,
        username: userSession.username,
        displayName: userSession.displayName,
        roles: userSession.roles,
        sessionId: userSession.sessionId
      };
      req.actor = {
        id: userSession.userId,
        type: 'HUMAN',
        displayName: userSession.displayName,
        roles: userSession.roles,
        via: 'BEARER_SESSION'
      };
      return next();
    }
  }

  // 3. Fallback for test harness running under NODE_ENV === 'test'
  if (process.env.NODE_ENV === 'test' && req.headers['x-test-user-id']) {
    const testUser = sec.getUserById(req.headers['x-test-user-id']) || sec.getUserByUsername(req.headers['x-test-user-id']);
    if (testUser) {
      req.user = {
        userId: testUser.user_id,
        username: testUser.username,
        displayName: testUser.display_name,
        roles: testUser.roles,
        sessionId: 'test-session'
      };
      req.actor = {
        id: testUser.user_id,
        type: 'HUMAN',
        displayName: testUser.display_name,
        roles: testUser.roles,
        via: 'TEST_HEADER'
      };
      return next();
    }
  }

  // Unauthenticated caller
  next();
}

/**
 * Requires valid authenticated caller (human or service)
 */
function requireAuth(req, res, next) {
  if (!req.user && !req.service) {
    return res.status(401).json({
      status: 'fail',
      code: 'UNAUTHORIZED',
      message: 'Authentication required. Please provide a valid session or service token.'
    });
  }
  next();
}

/**
 * Requires authenticated human user (rejects machine services)
 */
function requireHuman(req, res, next) {
  if (!req.user) {
    if (req.service) {
      return res.status(403).json({
        status: 'fail',
        code: 'FORBIDDEN_SERVICE',
        message: 'This operation requires an authenticated human user; machine service credentials are not permitted.'
      });
    }
    return res.status(401).json({
      status: 'fail',
      code: 'UNAUTHORIZED',
      message: 'Authentication required.'
    });
  }
  next();
}

/**
 * Requires machine service token (rejects human users)
 */
function requireService(req, res, next) {
  if (!req.service) {
    if (req.user) {
      return res.status(403).json({
        status: 'fail',
        code: 'FORBIDDEN_HUMAN',
        message: 'This operation requires a machine service identity; human user accounts cannot access this route.'
      });
    }
    return res.status(401).json({
      status: 'fail',
      code: 'UNAUTHORIZED',
      message: 'Machine service authentication required.'
    });
  }
  next();
}

/**
 * Requires caller to have at least one of the specified roles.
 * Supports human roles (OPERATOR, METALLURGIST, QUALITY_MANAGER, INVENTORY_CONTROLLER, SALES_FINANCE, ADMIN)
 * and machine service roles (SPECTROMETER_SERVICE, LAB_SERVICE).
 */
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user && !req.service) {
      return res.status(401).json({
        status: 'fail',
        code: 'UNAUTHORIZED',
        message: 'Authentication required.'
      });
    }

    // Machine service identity check
    if (req.service) {
      if (allowedRoles.includes(req.service.serviceType)) {
        return next();
      }
      return res.status(403).json({
        status: 'fail',
        code: 'FORBIDDEN_SERVICE_TYPE',
        message: `Service type ${req.service.serviceType} is not authorized for this operation. Required: ${allowedRoles.join(', ')}`
      });
    }

    // Human user role check
    const userRoles = req.user.roles || [];
    const hasRole = userRoles.some((r) => allowedRoles.includes(r)) || userRoles.includes('ADMIN');
    if (!hasRole) {
      return res.status(403).json({
        status: 'fail',
        code: 'FORBIDDEN',
        message: `User does not have required permissions. Required: ${allowedRoles.join(', ')}`
      });
    }

    next();
  };
}

/**
 * Double-Submit Cookie CSRF protection for cookie-authenticated mutating requests
 */
function csrfProtection(req, res, next) {
  const method = req.method.toUpperCase();
  // Safe HTTP methods do not require CSRF token
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    return next();
  }

  // Authenticate chooses the principal before this middleware runs. A raw
  // Authorization header cannot override cookie precedence or grant an exemption.
  // Successful bearer authentication carries no ambient cookie authority;
  // route guards still enforce authentication, RBAC and human/service separation.
  if (req.actor && req.actor.via === 'SESSION_COOKIE') {
    const csrfHeader = req.headers['x-csrf-token'];
    const csrfCookie = req.cookies.metallisense_csrf;

    if (!csrfHeader || !csrfCookie || csrfHeader !== csrfCookie) {
      return res.status(403).json({
        status: 'fail',
        code: 'CSRF_MISMATCH',
        message: 'Invalid or missing CSRF token in request headers.'
      });
    }
  }

  next();
}

/**
 * Restricts sensitive simulation, reset, or diagnostic routes to explicit development/test environments.
 * Permanently rejects requests in production with 403.
 */
function requireDevOrTest(featureName = 'This feature') {
  return (req, res, next) => {
    const env = (process.env.NODE_ENV || '').trim().toLowerCase();
    if (env === 'production' || (env !== 'development' && env !== 'test')) {
      return res.status(403).json({
        status: 'fail',
        code: 'FEATURE_DISABLED_IN_ENVIRONMENT',
        message: `${featureName} is permanently disabled in production and staging environments.`
      });
    }
    next();
  };
}

module.exports = {
  authenticate,
  requireAuth,
  requireHuman,
  requireService,
  requireRole,
  requireDevOrTest,
  csrfProtection,
  parseCookies
};
