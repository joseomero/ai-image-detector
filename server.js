const express  = require('express');
const multer   = require('multer');
const axios    = require('axios');
const FormData = require('form-data');
const path     = require('path');
const crypto   = require('crypto');
const { Pool } = require('pg');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Database ───────────────────────────────────────────────────────────────
const db = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

async function initDb() {
  if (!db) { console.warn('[db] DATABASE_URL not set — results will not be saved.'); return; }
  await db.query(`
    CREATE TABLE IF NOT EXISTS scans (
      id         SERIAL PRIMARY KEY,
      scan_id    TEXT        NOT NULL,
      filename   TEXT        NOT NULL,
      ai_pct     NUMERIC(5,2) NOT NULL,
      human_pct  NUMERIC(5,2) NOT NULL,
      width      INTEGER,
      height     INTEGER,
      sandbox    BOOLEAN     NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  console.log('[db] Connected and table ready.');
}

async function saveScan({ scanId, filename, aiPct, humanPct, width, height, sandbox }) {
  if (!db) return;
  await db.query(
    `INSERT INTO scans (scan_id, filename, ai_pct, human_pct, width, height, sandbox)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [scanId, filename, aiPct, humanPct, width || null, height || null, sandbox]
  );
}

// ── Auth state (never exposed to client) ──────────────────────────────────
let storedToken    = null;
let tokenFetchedAt = null;
const TOKEN_TTL_MS = 47 * 60 * 60 * 1000;

async function authenticate() {
  const email  = process.env.COPYLEAKS_EMAIL;
  const apiKey = process.env.COPYLEAKS_API_KEY;
  if (!email || !apiKey) {
    console.warn('[auth] COPYLEAKS_EMAIL / COPYLEAKS_API_KEY not set.');
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
    console.error('[auth] Authentication failed:', err.response?.data?.message || err.message);
  }
}

async function refreshIfNeeded() {
  if (!storedToken || Date.now() - tokenFetchedAt >= TOKEN_TTL_MS) {
    await authenticate();
  }
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── GET /api/status ────────────────────────────────────────────────────────
app.get('/api/status', (_req, res) => {
  const configured = Boolean(process.env.COPYLEAKS_EMAIL && process.env.COPYLEAKS_API_KEY);
  res.json({ authenticated: storedToken !== null, configured });
});

// ── GET /api/history ───────────────────────────────────────────────────────
app.get('/api/history', async (_req, res) => {
  if (!db) return res.json([]);
  try {
    const result = await db.query(
      `SELECT id, scan_id, filename, ai_pct, human_pct, width, height, sandbox, created_at
       FROM scans ORDER BY created_at DESC LIMIT 100`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[history]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/detect ───────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 32 * 1024 * 1024 },
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
  form.append('image',    req.file.buffer, { filename: req.file.originalname, contentType: req.file.mimetype });
  form.append('filename', req.file.originalname);
  form.append('sandbox',  String(sandbox));
  form.append('model',    'ai-image-1-ultra');

  try {
    const upstream = await axios.post(
      `https://api.copyleaks.com/v1/ai-image-detector/${scanId}/check`,
      form,
      {
        headers: { ...form.getHeaders(), Authorization: `Bearer ${storedToken}` },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      }
    );

    const data    = upstream.data;
    const aiPct   = data.summary?.ai    ?? 0;
    const humanPct = data.summary?.human ?? (100 - aiPct);
    const width   = data.imageInfo?.width;
    const height  = data.imageInfo?.height;

    console.log(`[detect] Scan ${scanId} complete — AI: ${aiPct}%`);
    await saveScan({ scanId, filename: req.file.originalname, aiPct, humanPct, width, height, sandbox });

    res.json(data);
  } catch (err) {
    if (err.response?.status === 401) {
      console.warn('[detect] Token rejected, re-authenticating…');
      await authenticate();
      if (!storedToken) return res.status(401).json({ error: 'Re-authentication failed.' });

      const retryForm = new FormData();
      retryForm.append('image',    req.file.buffer, { filename: req.file.originalname, contentType: req.file.mimetype });
      retryForm.append('filename', req.file.originalname);
      retryForm.append('sandbox',  String(sandbox));
      retryForm.append('model',    'ai-image-1-ultra');

      try {
        const retry = await axios.post(
          `https://api.copyleaks.com/v1/ai-image-detector/${scanId}/check`,
          retryForm,
          {
            headers: { ...retryForm.getHeaders(), Authorization: `Bearer ${storedToken}` },
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
          }
        );
        const data     = retry.data;
        const aiPct    = data.summary?.ai    ?? 0;
        const humanPct = data.summary?.human ?? (100 - aiPct);
        await saveScan({ scanId, filename: req.file.originalname, aiPct, humanPct, width: data.imageInfo?.width, height: data.imageInfo?.height, sandbox });
        return res.json(data);
      } catch (retryErr) {
        return res.status(retryErr.response?.status || 500).json({ error: retryErr.response?.data?.message || retryErr.message });
      }
    }
    const msg = err.response?.data?.message || err.message;
    console.error(`[detect] Scan ${scanId} failed:`, msg);
    res.status(err.response?.status || 500).json({ error: msg });
  }
});

// ── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\nAI Image Detector running at http://localhost:${PORT}`);
  await initDb();
  await authenticate();
  setInterval(authenticate, TOKEN_TTL_MS);
});
