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
import { createClient } from '@supabase/supabase-js';

const app = express();

/* =========================
   Middleware
   ========================= */
app.use(cors());
app.use(compression());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* =========================
   Env
   ========================= */
// LocationIQ / reCAPTCHA
const LOCATIONIQ_TOKEN      = (process.env.LOCATIONIQ_TOKEN || '').trim();
const RECAPTCHA_SECRET      = (process.env.RECAPTCHA_SECRET || '').trim();

// AI Blog / Supabase env
const OPENAI_API_KEY        = (process.env.OPENAI_API_KEY || '').trim();
const CRON_SECRET           = (process.env.CRON_SECRET || '').trim();
const SUPABASE_URL          = (process.env.SUPABASE_URL || '').trim();
const SUPABASE_SERVICE_ROLE = (process.env.SUPABASE_SERVICE_ROLE || '').trim();
const MODEL_NAME            = process.env.MODEL_NAME || 'gpt-4o-mini';
const MAX_POSTS_PER_MONTH   = Number(process.env.MAX_POSTS_PER_MONTH || 0); // 0 = unlimited

// Guard critical envs early (don’t crash, but log)
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
  console.warn('[boot] Missing Supabase URL or Service Role key. Some routes will fail until set.');
}

/* =========================
   Supabase (service role for server-side writes)
   ========================= */
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

/* =========================
   Keep-alive agents & tiny cache
   ========================= */
const httpAgent  = new HttpAgent({ keepAlive: true, maxSockets: 50, keepAliveMsecs: 10_000 });
const httpsAgent = new HttpsAgent({ keepAlive: true, maxSockets: 50, keepAliveMsecs: 10_000 });

const cache = new LRU({
  max: 500,
  ttl: 1000 * 60 * 3 // default 3 min
});

/* =========================
   Boot log
   ========================= */
console.log(
  '[boot]',
  new Date().toISOString(),
  'routes:',
  '/health',
  '/env-check',
  '/posts-stats',
  '/api/autocomplete',
  '/api/geocode',
  '/api/verify-captcha',
  '/warm',
  '/api/auto-post',
  '/api/auto-post-test'
);

/* =========================
   Health
   ========================= */
app.get('/health', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.status(200).json({ ok: true, uptime: process.uptime() });
});

/* =========================
   Helper: fetch JSON with timeout + keep-alive
   ========================= */
async function fetchJSON(url, opts = {}, timeoutMs = 6000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const isHttps = url.startsWith('https:');
    const resp = await fetch(url, {
      agent: isHttps ? httpsAgent : httpAgent,
      signal: controller.signal,
      ...opts
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

/* =========================
   LocationIQ proxy (server-side token)
   ========================= */

// Autocomplete (suggestions)
app.get('/api/autocomplete', async (req, res) => {
  try {
    if (!LOCATIONIQ_TOKEN) {
      return res.status(500).json({ error: 'Missing LOCATIONIQ_TOKEN' });
    }
    const q = (req.query.q || '').toString().trim();
    if (!q) return res.status(400).json({ error: 'Missing query' });

    const limit = Math.min(parseInt(req.query.limit || '8', 10) || 8, 15);
    const countrycodes = (req.query.countrycodes || 'us').toString();

    const key = `ac:${q}:${limit}:${countrycodes}`;
    const hit = cache.get(key);
    if (hit) {
      res.set('Cache-Control', 'public, max-age=120');
      return res.json(hit);
    }

    const url = `https://us1.locationiq.com/v1/autocomplete?key=${encodeURIComponent(
      LOCATIONIQ_TOKEN
    )}&q=${encodeURIComponent(q)}&limit=${limit}&normalizeaddress=1&dedupe=1&countrycodes=${encodeURIComponent(
      countrycodes
    )}`;

    const data = await fetchJSON(url);
    cache.set(key, data, { ttl: 1000 * 60 * 2 });
    res.set('Cache-Control', 'public, max-age=120');
    res.json(data);
  } catch (err) {
    console.error('Autocomplete error:', err.message || err);
    res.status(502).json({ error: 'Autocomplete fetch failed' });
  }
});

// Geocode (full search)
app.get('/api/geocode', async (req, res) => {
  try {
    if (!LOCATIONIQ_TOKEN) {
      return res.status(500).json({ error: 'Missing LOCATIONIQ_TOKEN' });
    }
    const q = (req.query.q || '').toString().trim();
    if (!q) return res.status(400).json({ error: 'Missing query' });

    const key = `geo:${q}`;
    const hit = cache.get(key);
    if (hit) {
      res.set('Cache-Control', 'public, max-age=300');
      return res.json(hit);
    }

    const url = `https://us1.locationiq.com/v1/search.php?key=${encodeURIComponent(
      LOCATIONIQ_TOKEN
    )}&q=${encodeURIComponent(q)}&format=json&normalizeaddress=1&dedupe=1`;

    const data = await fetchJSON(url);
    cache.set(key, data, { ttl: 1000 * 60 * 5 });
    res.set('Cache-Control', 'public, max-age=300');
    res.json(data);
  } catch (err) {
    console.error('Geocoding error:', err.message || err);
    res.status(502).json({ error: 'Geocoding fetch failed' });
  }
});

/* =========================
   reCAPTCHA verify (server-side)
   ========================= */
app.post('/api/verify-captcha', async (req, res) => {
  try {
    const token = (req.body?.token || '').toString();
    if (!token) return res.status(400).json({ error: 'Missing token' });
    if (!RECAPTCHA_SECRET) return res.status(500).json({ error: 'Missing RECAPTCHA_SECRET' });

    const data = await fetchJSON(
      'https://www.google.com/recaptcha/api/siteverify',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `secret=${encodeURIComponent(RECAPTCHA_SECRET)}&response=${encodeURIComponent(token)}`
      },
      5000
    );
    res.set('Cache-Control', 'no-store');
    res.json(data);
  } catch (err) {
    console.error('reCAPTCHA error:', err.message || err);
    res.status(502).json({ error: 'Verification failed' });
  }
});

/* =========================
   Warm upstreams (optional)
   ========================= */
app.get('/warm', async (_req, res) => {
  try {
    await Promise.allSettled([
      LOCATIONIQ_TOKEN
        ? fetchJSON(
            `https://us1.locationiq.com/v1/autocomplete?key=${encodeURIComponent(
              LOCATIONIQ_TOKEN
            )}&q=ping&limit=1`,
            {},
            3000
          )
        : Promise.resolve(),
      RECAPTCHA_SECRET
        ? fetchJSON(
            'https://www.google.com/recaptcha/api/siteverify',
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: `secret=${encodeURIComponent(RECAPTCHA_SECRET)}&response=dummy`
            },
            3000
          )
        : Promise.resolve()
    ]);
    res.json({ ok: true });
  } catch {
    res.json({ ok: true });
  }
});

/* =========================
   AI BLOG WRITER
   ========================= */

// Utilities
const slugify = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 90);

const TOPIC_POOL = [
  'Best outdoor courts in Minneapolis for pickup runs',
  'How to organize a 3v3 at your local park (checklist)',
  'Beginner shooting drills you can do solo',
  'How to find indoor open gym times in your city',
  'Gear guide: budget shoes that grip blacktop',
  'Safety and etiquette at public courts',
  'How we’re mapping courts (data process + roadmap)',
  'Community spotlight: user-submitted courts this week',
  'Seasonal prep: winter hooping options & indoor passes',
  'Pro tips: stretching and warm-ups to avoid injury'
];

async function pickTopic() {
  const { data: posts } = await supabase
    .from('posts')
    .select('slug')
    .order('published_at', { ascending: false })
    .limit(500);

  const existing = new Set((posts || []).map((p) => p.slug));
  for (const t of TOPIC_POOL) {
    if (!existing.has(slugify(t))) return t;
  }
  return `${TOPIC_POOL[0]} ${new Date().toISOString().slice(0, 10)}`;
}

async function openaiChat(system, user) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is missing');
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: MODEL_NAME,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      temperature: 0.8
    })
  });
  if (!resp.ok) throw new Error(`[OpenAI] ${resp.status} ${await resp.text()}`);
  const json = await resp.json();
  return json.choices?.[0]?.message?.content || '';
}

async function generatePost(topic) {
  const system = `You write for HoopMap's "Courtside" blog. Audience: casual hoopers. Tone: practical, upbeat. Output Markdown only.`;
  const prompt = `Write an 800–1200 word post about "${topic}".
- Start with a 1–2 sentence excerpt delimited by <<<excerpt>>> ... <<<end>>>
- Use H2s for sections; lists when helpful
- End with "Tags: a, b, c" (5 tags max)
- Do NOT include a title in the body`;

  const md = await openaiChat(system, prompt);
  if (!md) throw new Error('No content returned from OpenAI');

  const excerptMatch = md.match(/<<<excerpt>>>([\s\S]*?)<<<end>>>/i);
  const excerpt = excerptMatch ? excerptMatch[1].trim() : '';
  const body = md.replace(/<<<excerpt>>>([\s\S]*?)<<<end>>>/i, '').trim();

  const tagsLine = body.match(/^\s*Tags:\s*(.+)$/im)?.[1] || '';
  const tags = tagsLine
    ? tags
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    : [];
  const content = body.replace(/^\s*Tags:\s*.+$/im, '').trim();

  return { excerpt, content, tags };
}

// Ensure unique slug by checking DB; append -1, -2, ... if taken
async function ensureUniqueSlug(slugBase, limit = 50) {
  let candidate = slugBase;
  for (let i = 0; i < limit; i++) {
    const { data, error } = await supabase
      .from('posts')
      .select('id')
      .eq('slug', candidate)
      .maybeSingle();

    // Not found -> good to use
    if (!data && (error?.code === 'PGRST116' || !error)) return candidate;

    // If found or ambiguous, try next
    candidate = `${slugBase}-${i + 1}`;
  }
  // Absolute fallback: timestamp
  return `${slugBase}-${Date.now()}`;
}

// Month range & count helpers (UTC)
function getMonthRangeUTC(date = new Date()) {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 0, 0, 0));
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1, 0, 0, 0));
  return { start, end };
}

async function countPostsThisMonth() {
  const { start, end } = getMonthRangeUTC(new Date());
  const { count, error } = await supabase
    .from('posts')
    .select('id', { count: 'exact', head: true })
    .gte('published_at', start.toISOString())
    .lt('published_at', end.toISOString());
  if (error) throw error;
  return count || 0;
}

// POST /api/auto-post (secured by X-Cron-Secret or ?secret=)
app.post('/api/auto-post', async (req, res) => {
  try {
    if (!CRON_SECRET) return res.status(500).json({ error: 'Missing CRON_SECRET' });
    const secret = req.headers['x-cron-secret'] || req.query.secret;
    if (secret !== CRON_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
      return res.status(500).json({ error: 'Supabase env missing' });
    }

    // Soft monthly limit
    if (MAX_POSTS_PER_MONTH > 0) {
      const count = await countPostsThisMonth();
      if (count >= MAX_POSTS_PER_MONTH) {
        return res.status(429).json({
          error: 'Monthly post limit reached',
          limit: MAX_POSTS_PER_MONTH,
          currentMonthCount: count
        });
      }
    }

    const topic = (req.body && req.body.topic) || (await pickTopic());
    const title = (req.body && req.body.title) || topic;
    const base = slugify(title);
    const slug = await ensureUniqueSlug(base);

    const { excerpt, content, tags } = await generatePost(topic);
    const hero_url = `https://source.unsplash.com/featured/?basketball,court,${encodeURIComponent(
      title.slice(0, 50)
    )}`;
    const now = new Date().toISOString();

    const { error } = await supabase.from('posts').insert([
      {
        title,
        slug,
        excerpt,
        content,
        hero_url,
        category: 'Guide',
        tags,
        published_at: now,
        updated_at: now
      }
    ]);
    if (error) throw error;

    res.json({ ok: true, title, slug, tags });
  } catch (err) {
    console.error('[auto-post]', err.message || err);
    res.status(500).json({ error: err.message || 'Failed' });
  }
});

// GET /api/auto-post-test (browser-friendly)
app.get('/api/auto-post-test', async (req, res) => {
  try {
    if (!CRON_SECRET) return res.status(500).json({ error: 'Missing CRON_SECRET' });
    const secret = req.query.secret;
    if (secret !== CRON_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (MAX_POSTS_PER_MONTH > 0) {
      const count = await countPostsThisMonth();
      if (count >= MAX_POSTS_PER_MONTH) {
        return res.status(429).json({
          error: 'Monthly post limit reached',
          limit: MAX_POSTS_PER_MONTH,
          currentMonthCount: count
        });
      }
    }

    const topic = req.query.topic || (await pickTopic());
    const title = req.query.title || topic;
    const base = slugify(title);
    const slug = await ensureUniqueSlug(base);

    const { excerpt, content, tags } = await generatePost(topic);
    const hero_url = `https://source.unsplash.com/featured/?basketball,court,${encodeURIComponent(
      title.slice(0, 50)
    )}`;
    const now = new Date().toISOString();

    const { error } = await supabase.from('posts').insert([
      {
        title,
        slug,
        excerpt,
        content,
        hero_url,
        category: 'Guide',
        tags,
        published_at: now,
        updated_at: now
      }
    ]);
    if (error) throw error;

    res.json({ ok: true, title, slug, tags, via: 'GET-test' });
  } catch (err) {
    console.error('[auto-post-test]', err.message || err);
    res.status(500).json({ error: err.message || 'Failed' });
  }
});

/* =========================
   Env check (booleans only)
   ========================= */
app.get('/env-check', (_req, res) => {
  res.json({
    OPENAI_API_KEY: !!OPENAI_API_KEY,
    CRON_SECRET: !!CRON_SECRET,
    SUPABASE_URL: !!SUPABASE_URL,
    SUPABASE_SERVICE_ROLE: !!SUPABASE_SERVICE_ROLE,
    MODEL_NAME,
    MAX_POSTS_PER_MONTH: MAX_POSTS_PER_MONTH || 0,
    LOCATIONIQ_TOKEN: !!LOCATIONIQ_TOKEN,
    RECAPTCHA_SECRET: !!RECAPTCHA_SECRET
  });
});

/* =========================
   POSTS STATS & COST ESTIMATE
   ========================= */
const PRICING = {
  model: MODEL_NAME,
  input_per_1k: 0.0006,   // $/1k tokens
  output_per_1k: 0.0024,  // $/1k tokens
  prompt_tokens: 400,     // est
  completion_tokens: 5000 // est for 800–1200 words
};

function estimateCostPerPostUSD() {
  const inputCost  = (PRICING.prompt_tokens / 1000)     * PRICING.input_per_1k;
  const outputCost = (PRICING.completion_tokens / 1000) * PRICING.output_per_1k;
  return +(inputCost + outputCost).toFixed(4);
}

app.get('/posts-stats', async (_req, res) => {
  try {
    const { start, end } = getMonthRangeUTC(new Date());
    const { count, error } = await supabase
      .from('posts')
      .select('id', { count: 'exact', head: true })
      .gte('published_at', start.toISOString())
      .lt('published_at', end.toISOString());
    if (error) throw error;

    const perPost = estimateCostPerPostUSD();
    const total = +((count || 0) * perPost).toFixed(4);

    res.json({
      monthStartUTC: start.toISOString(),
      monthEndUTC: end.toISOString(),
      postsThisMonth: count || 0,
      estCostPerPostUSD: perPost,
      estMonthlyCostUSD: total,
      maxPostsPerMonth: MAX_POSTS_PER_MONTH || 0,
      pricing: {
        model: PRICING.model,
        input_per_1k_usd: PRICING.input_per_1k,
        output_per_1k_usd: PRICING.output_per_1k,
        prompt_tokens_est: PRICING.prompt_tokens,
        completion_tokens_est: PRICING.completion_tokens
      }
    });
  } catch (err) {
    console.error('[posts-stats]', err.message || err);
    res.status(500).json({ error: err.message || 'Failed' });
  }
});

/* =========================
   Start server
   ========================= */
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`API listening on :${PORT}`);
});
