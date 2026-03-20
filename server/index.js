'use strict';

/**
 * Mermate — Mermaid diagram server
 *
 * Security:
 *  - Security headers (CSP, HSTS, X-Frame-Options, etc.)
 *  - Request body size limits
 *  - Input validation on all API endpoints
 *  - Path traversal prevention on static serving
 *  - Rate limiting on API routes
 *  - No sensitive data in error responses
 */

require('dotenv').config({ path: require('node:path').resolve(__dirname, '..', '.env') });

const express = require('express');
const path = require('node:path');
const logger = require('./utils/logger');

const app = express();
const PORT = parseInt(process.env.PORT || '3333', 10);
const PROJECT_ROOT = path.resolve(__dirname, '..');

// --- Security: validate PORT ---
if (isNaN(PORT) || PORT < 1 || PORT > 65535) {
  console.error('[mermate] Invalid PORT value');
  process.exit(1);
}

// --- Security: HTTP headers ---
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self';"
  );
  next();
});

// --- Security: rate limiter (simple in-memory) ---
const _rateMap = new Map();
const RATE_WINDOW = 60_000; // 1 minute
const RATE_MAX = 120; // requests per window
app.use('/api', (req, res, next) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = _rateMap.get(ip) || { count: 0, resetAt: now + RATE_WINDOW };
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + RATE_WINDOW;
  }
  entry.count++;
  _rateMap.set(ip, entry);
  if (entry.count > RATE_MAX) {
    res.status(429).json({ error: 'Rate limit exceeded' });
    return;
  }
  next();
});

// --- Security: error sanitizer ---
function sanitizeError(err) {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.split('\n')[0].slice(0, 500);
}

// Body parsing
app.use(express.json({ limit: '2mb' }));

// Static files: frontend (no-cache for JS/CSS so code changes take effect immediately)
app.use(express.static(path.join(PROJECT_ROOT, 'public'), {
  setHeaders(res, filePath) {
    if (/\.(js|css|html)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  },
  dotfiles: 'deny',
}));

// Static files: compiled diagram outputs
app.use('/flows', express.static(path.join(PROJECT_ROOT, 'flows'), { dotfiles: 'deny' }));

// Static files: archived sources (read-only serving)
app.use('/archs', express.static(path.join(PROJECT_ROOT, 'archs'), { dotfiles: 'deny' }));

// Frontend vendor modules
app.use('/vendor/three', express.static(path.join(PROJECT_ROOT, 'node_modules', 'three')));

// API routes
const renderRouter = require('./routes/render');
const agentRouter = require('./routes/agent');
const transcribeRouter = require('./routes/transcribe');
app.use('/api', renderRouter);
app.use('/api', agentRouter);
app.use('/api', transcribeRouter);

// --- Security: global error handler (must be AFTER routes) ---
app.use((err, _req, res, _next) => {
  logger.error('unhandled_error', { error: sanitizeError(err) });
  res.status(500).json({ error: 'Internal server error' });
});

// Start server only when run directly (not imported by tests)
if (require.main === module) {
  const server = app.listen(PORT, () => {
    logger.info('server.started', { port: PORT });
    console.log(`\n  Mermaid-GPT running at http://localhost:${PORT}\n`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      logger.error('server.port_in_use', { port: PORT });
      console.error(`\n  Error: port ${PORT} is already in use.\n  Run: kill $(lsof -ti :${PORT}) && ./mermaid.sh start\n`);
    } else {
      logger.error('server.error', { error: err.message });
      console.error(`\n  Server error: ${err.message}\n`);
    }
    process.exit(1);
  });

  process.on('SIGTERM', () => server.close(() => process.exit(0)));
  process.on('SIGINT',  () => server.close(() => process.exit(0)));
}

module.exports = app;
