// --- server.mjs ---
import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import fetch from 'node-fetch';
import cors from 'cors';
import compression from 'compression';
import LRU from 'lru-cache';
import { Agent as HttpAgent } from 'http';
import { Agent as HttpsAgent } from 'https';

const app = express();

// Middleware
app.use(cors());
app.use(compression()); // only once
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Env
const LOCATIONIQ_API_KEY = process.env.VITE_LOCATIONIQ_API_KEY;
const RECAPTCHA_SECRET   = process.env.RECAPTCHA_SECRET;

// Keep-alive agents (reduce TLS overhead on every request)
const httpAgent  = new HttpAgent({ keepAlive: true, maxSockets: 50, keepAliveMsecs: 10_000 });
const httpsAgent = new HttpsAgent({ keepAlive: true, maxSockets: 50, keepAliveMsecs: 10_000 });

// Tiny cache (reduces duplicate calls to LocationIQ)
const cache = new LRU({
  max: 500,
  ttl: 1000 * 60 * 3, // default 3 min
});

// Health endpoint (for UptimeRobot)
app.get('/health', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.status(200).json({ ok: true, uptime: process.uptime() });
});

// Helper: fetch with timeout + keep-alive, returns JSON
async function fetchJSON(url, opts = {}, timeoutMs = 6000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const isHttps = url.startsWith('https:');
    const resp = await fetch(url, {
      agent: isHttps ? httpsAgent : httpAgent,
      signal: controller.signal,
      ...opts,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Fetch failed ${resp.status}: ${text || resp.statusText}`);
    }
    return await resp.json();
  } finally {
    clearTimeout(t);
  }
}

// Autocomplete endpoint (cached ~2 min)
app.get('/api/autocomplete', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'Missing query' });

  const key = `ac:${q}`;
  const hit = cache.get(key);
  if (hit) {
    res.set('Cache-Control', 'public, max-age=120');
    return res.json(hit);
  }

  try {
    const url = `https://us1.locationiq.com/v1/autocomplete?key=${LOCATIONIQ_API_KEY}&q=${encodeURIComponent(q)}&format=json`;
    const data = await fetchJSON(url);
    cache.set(key, data, { ttl: 1000 * 60 * 2 });
    res.set('Cache-Control', 'public, max-age=120');
    res.json(data);
  } catch (err) {
    console.error('Autocomplete error:', err.message);
    res.status(502).json({ error: 'Autocomplete fetch failed' });
  }
});

// Geocode endpoint (cached ~5 min)
app.get('/api/geocode', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'Missing query' });

  const key = `geo:${q}`;
  const hit = cache.get(key);
  if (hit) {
    res.set('Cache-Control', 'public, max-age=300');
    return res.json(hit);
  }

  try {
    const url = `https://us1.locationiq.com/v1/search.php?key=${LOCATIONIQ_API_KEY}&q=${encodeURIComponent(q)}&format=json`;
    const data = await fetchJSON(url);
    cache.set(key, data, { ttl: 1000 * 60 * 5 });
    res.set('Cache-Control', 'public, max-age=300');
    res.json(data);
  } catch (err) {
    console.error('Geocoding error:', err.message);
    res.status(502).json({ error: 'Geocoding fetch failed' });
  }
});

// reCAPTCHA verification (short timeout)
app.post('/api/verify-captcha', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Missing token' });

  try {
    const data = await fetchJSON(
      'https://www.google.com/recaptcha/api/siteverify',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `secret=${RECAPTCHA_SECRET}&response=${token}`,
      },
      5000
    );
    res.set('Cache-Control', 'no-store');
    res.json(data);
  } catch (err) {
    console.error('reCAPTCHA error:', err.message);
    res.status(502).json({ error: 'Verification failed' });
  }
});

// Optional: deep warm route
app.get('/warm', async (_req, res) => {
  try {
    await Promise.allSettled([
      fetchJSON(`https://us1.locationiq.com/v1/autocomplete?key=${LOCATIONIQ_API_KEY}&q=ping&format=json`, {}, 3000),
      fetchJSON(`https://www.google.com/recaptcha/api/siteverify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `secret=${RECAPTCHA_SECRET}&response=dummy`,
      }, 3000),
    ]);
    res.json({ ok: true });
  } catch {
    res.json({ ok: true }); // don’t fail warmups
  }
});

// Start server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Proxy server running on port ${PORT}`);
});
