const express  = require('express');
const multer   = require('multer');
const axios    = require('axios');
const FormData = require('form-data');
const path     = require('path');
const crypto   = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

// Token stored in memory — never sent to the client
let storedToken = process.env.COPYLEAKS_TOKEN || null;

app.use(express.json());

// Serve the frontend
app.use(express.static(path.join(__dirname)));

// ── POST /api/token ────────────────────────────────────────────────────────
// Accept a pre-obtained Copyleaks bearer token and store it server-side.
// The token is never echoed back to the client.
app.post('/api/token', (req, res) => {
  const { token } = req.body;
  if (!token || typeof token !== 'string' || token.trim().length === 0) {
    return res.status(400).json({ error: 'token field is required.' });
  }
  storedToken = token.trim();
  console.log('[token] Token stored successfully.');
  res.json({ ok: true, message: 'Token stored. Ready to scan.' });
});

// ── POST /api/login ────────────────────────────────────────────────────────
// Optional: let the server fetch a token using email + API key so the
// credentials never leave the server either.
app.post('/api/login', async (req, res) => {
  const { email, key } = req.body;
  if (!email || !key) {
    return res.status(400).json({ error: 'email and key are required.' });
  }

  try {
    const response = await axios.post(
      'https://id.copyleaks.com/v3/account/login/api',
      { email, key },
      { headers: { 'Content-Type': 'application/json' } }
    );
    storedToken = response.data.access_token || response.data.token;
    if (!storedToken) throw new Error('No token returned by Copyleaks.');
    console.log('[login] Authenticated successfully.');
    res.json({ ok: true, message: 'Authenticated. Token stored server-side.' });
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    console.error('[login] Failed:', msg);
    res.status(401).json({ error: `Authentication failed: ${msg}` });
  }
});

// ── POST /api/detect ───────────────────────────────────────────────────────
// Accepts multipart/form-data with an `image` file, forwards to Copyleaks
// using the stored token, and returns the raw API response.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 32 * 1024 * 1024 }, // 32 MB
});

app.post('/api/detect', upload.single('image'), async (req, res) => {
  if (!storedToken) {
    return res.status(401).json({ error: 'No token set. POST /api/token first.' });
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
    const msg    = err.response?.data?.message || err.message;
    const status = err.response?.status        || 500;
    console.error(`[detect] Scan ${scanId} failed:`, msg);
    res.status(status).json({ error: msg });
  }
});

// ── Status ─────────────────────────────────────────────────────────────────
app.get('/api/status', (_req, res) => {
  res.json({ tokenSet: storedToken !== null });
});

// ── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\nAI Image Detector running at http://localhost:${PORT}`);
  if (storedToken) {
    console.log('Token pre-loaded from COPYLEAKS_TOKEN env var.');
  } else {
    console.log('No token set. Use the UI or POST /api/token to set one.\n');
  }
});
