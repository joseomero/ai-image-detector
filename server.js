const express  = require('express');
const multer   = require('multer');
const axios    = require('axios');
const FormData = require('form-data');
const path     = require('path');
const crypto   = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Auth state (never exposed to client) ──────────────────────────────────
let storedToken   = null;
let tokenFetchedAt = null;
const TOKEN_TTL_MS = 47 * 60 * 60 * 1000; // refresh 1 h before 48 h expiry

async function authenticate() {
  const email  = process.env.COPYLEAKS_EMAIL;
  const apiKey = process.env.COPYLEAKS_API_KEY;

  if (!email || !apiKey) {
    console.warn('[auth] COPYLEAKS_EMAIL / COPYLEAKS_API_KEY not set. Set them as env vars.');
    return;
  }

  try {
    const res = await axios.post(
      'https://id.copyleaks.com/v3/account/login/api',
      { email, key: apiKey },
      { headers: { 'Content-Type': 'application/json' } }
    );
    storedToken    = res.data.access_token || res.data.token;
    tokenFetchedAt = Date.now();
    console.log('[auth] Authenticated with Copyleaks successfully.');
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    console.error('[auth] Authentication failed:', msg);
  }
}

// Refresh the token automatically before it expires
async function refreshIfNeeded() {
  if (!storedToken || Date.now() - tokenFetchedAt >= TOKEN_TTL_MS) {
    await authenticate();
  }
}

app.use(express.json());

// Serve the frontend
app.use(express.static(path.join(__dirname, 'public')));

// ── GET /api/status ────────────────────────────────────────────────────────
app.get('/api/status', (_req, res) => {
  const configured = Boolean(process.env.COPYLEAKS_EMAIL && process.env.COPYLEAKS_API_KEY);
  res.json({ authenticated: storedToken !== null, configured });
});

// ── POST /api/detect ───────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 32 * 1024 * 1024 }, // 32 MB
});

app.post('/api/detect', upload.single('image'), async (req, res) => {
  await refreshIfNeeded();

  if (!storedToken) {
    return res.status(401).json({
      error: 'Not authenticated. Set COPYLEAKS_EMAIL and COPYLEAKS_API_KEY environment variables.',
    });
  }

  if (!req.file) {
    return res.status(400).json({ error: 'No image file provided.' });
  }

  const scanId  = crypto.randomUUID();
  const sandbox = req.body.sandbox === 'true';

  const form = new FormData();
  form.append('image',    req.file.buffer, {
    filename:    req.file.originalname,
    contentType: req.file.mimetype,
  });
  form.append('filename', req.file.originalname);
  form.append('sandbox',  String(sandbox));
  form.append('model',    'ai-image-1-ultra');

  try {
    const upstream = await axios.post(
      `https://api.copyleaks.com/v1/ai-image-detector/${scanId}/check`,
      form,
      {
        headers: {
          ...form.getHeaders(),
          Authorization: `Bearer ${storedToken}`,
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      }
    );

    console.log(`[detect] Scan ${scanId} complete — AI: ${upstream.data?.summary?.ai ?? '?'}%`);
    res.json(upstream.data);
  } catch (err) {
    // If token expired mid-flight, re-auth once and retry
    if (err.response?.status === 401) {
      console.warn('[detect] Token rejected, re-authenticating…');
      await authenticate();
      if (!storedToken) {
        return res.status(401).json({ error: 'Re-authentication failed.' });
      }
      form.set
        ? form.set('image', req.file.buffer, { filename: req.file.originalname, contentType: req.file.mimetype })
        : null;
      try {
        const retry = await axios.post(
          `https://api.copyleaks.com/v1/ai-image-detector/${scanId}/check`,
          form,
          {
            headers: { ...form.getHeaders(), Authorization: `Bearer ${storedToken}` },
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
          }
        );
        return res.json(retry.data);
      } catch (retryErr) {
        const msg = retryErr.response?.data?.message || retryErr.message;
        return res.status(retryErr.response?.status || 500).json({ error: msg });
      }
    }

    const msg    = err.response?.data?.message || err.message;
    const status = err.response?.status        || 500;
    console.error(`[detect] Scan ${scanId} failed:`, msg);
    res.status(status).json({ error: msg });
  }
});

// ── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\nAI Image Detector running at http://localhost:${PORT}`);
  await authenticate();
  // Schedule token refresh every 47 hours
  setInterval(authenticate, TOKEN_TTL_MS);
});
