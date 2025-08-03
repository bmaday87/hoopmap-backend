// --- server.mjs ---
import express from 'express';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import cors from 'cors';

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const LOCATIONIQ_API_KEY = process.env.VITE_LOCATIONIQ_API_KEY;
const RECAPTCHA_SECRET = process.env.RECAPTCHA_SECRET;

// Autocomplete endpoint
app.get('/api/autocomplete', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'Missing query' });

  try {
    const response = await fetch(`https://us1.locationiq.com/v1/autocomplete?key=${LOCATIONIQ_API_KEY}&q=${encodeURIComponent(q)}&format=json`);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Autocomplete error:', err);
    res.status(500).json({ error: 'Autocomplete fetch failed' });
  }
});

// Geocode endpoint (used to get lat/lng from address)
app.get('/api/geocode', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'Missing query' });

  try {
    const response = await fetch(`https://us1.locationiq.com/v1/search.php?key=${LOCATIONIQ_API_KEY}&q=${encodeURIComponent(q)}&format=json`);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Geocoding error:', err);
    res.status(500).json({ error: 'Geocoding fetch failed' });
  }
});

// reCAPTCHA verification
app.post('/api/verify-captcha', async (req, res) => {
  const { token } = req.body;

  if (!token) {
    return res.status(400).json({ error: 'Missing token' });
  }

  try {
    const verifyResponse = await fetch('https://www.google.com/recaptcha/api/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `secret=${RECAPTCHA_SECRET}&response=${token}`,
    });

    const data = await verifyResponse.json();
    res.json(data);
  } catch (err) {
    console.error('reCAPTCHA error:', err);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// Start server
app.listen(3001, () => {
  console.log('Proxy server running at http://localhost:3001');
});
