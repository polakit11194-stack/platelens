// Plate Lens server. No dependencies: Node 18+ only.
// Serves public/index.html and one API route, POST /api/analyze, which sends the
// photo to Claude using your ANTHROPIC_API_KEY. The key never reaches the browser.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
const API_URL = process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com/v1/messages';
const PER_IP_HOUR = Number(process.env.LIMIT_PER_IP_HOUR) || 10;   // photos per visitor per hour
const PER_DAY = Number(process.env.LIMIT_PER_DAY) || 150;           // photos per day, all visitors
const MAX_BYTES = 6 * 1024 * 1024;

const PROMPT = [
  'You are a careful nutrition analyst. Look at the attached food photo and estimate its nutrition.',
  'The photo carries a faint dashed reference grid added by the app. Grid lines sit every 0.1 of the width and height, and each line is labeled (0.1 to 0.9) along all four edges. The grid is not part of the food. Use it to read coordinates.',
  '',
  'Reply with ONLY one JSON object, no other text, in this shape:',
  '{"is_food": true, "dish": "Classic cheeseburger", "serving_note": "1 burger, about 340 g", "confidence": "medium", "note": "One short sentence about the meal.", "items": [{"name": "Bun", "box": [0.18, 0.1, 0.82, 0.38], "point": [0.5, 0.24], "grams": 60, "kcal": 160, "protein_g": 5, "carbs_g": 30, "fat_g": 2, "fiber_g": 1.5, "sugar_g": 4, "sodium_mg": 280}]}',
  '',
  'Rules:',
  '- is_food is false if the photo does not show food or drink; then items may be empty.',
  '- List 3 to 8 visible components (ingredients or parts of the dish), one entry each, named in 1 to 2 plain words (Bun, Beef patty, Lettuce, Cheese).',
  '- All coordinates are fractions of the full image from 0 to 1, origin at the top-left corner: x runs left to right, y runs top to bottom.',
  '- box is [x1, y1, x2, y2], a tight rectangle around every visible part of that component.',
  '- point is [x, y], one spot that lies ON the component itself, near its visual center. For thin, curved or ring-shaped items, pick a spot on the item, not in the gap. Never place a point on the plate, the table, or a neighboring component.',
  '- Before answering, check that every point sits inside its own box and on the right ingredient, and that no two points share a spot.',
  '- Estimate grams and nutrition for the portion shown. Use realistic whole numbers (fiber_g and sugar_g may have one decimal).',
  '- All numbers are plain numbers without units.'
].join('\n');

const indexHtml = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));

/* ---------- limits ---------- */
const hits = new Map(); // ip -> timestamps (ms) within the last hour
let day = '', dayCount = 0;

function clientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf) return cf.trim();
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff) return xff.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}
function ipAllowed(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 3600e3);
  if (list.length >= PER_IP_HOUR) { hits.set(ip, list); return false; }
  list.push(now);
  hits.set(ip, list);
  return true;
}
function dayAllowed() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== day) { day = today; dayCount = 0; }
  if (dayCount >= PER_DAY) return false;
  dayCount++;
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, list] of hits) {
    const kept = list.filter((t) => now - t < 3600e3);
    if (kept.length) hits.set(ip, kept); else hits.delete(ip);
  }
}, 10 * 60e3).unref();

/* ---------- helpers ---------- */
function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
const fail = (res, status, code) => send(res, status, { code });

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > MAX_BYTES) { done = true; chunks.length = 0; reject(Object.assign(new Error('too large'), { status: 413 })); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    req.on('error', (e) => { if (!done) { done = true; reject(e); } });
  });
}

function parseJson(text) {
  try { return JSON.parse(text); } catch (e) { /* fall through */ }
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { try { return JSON.parse(fence[1]); } catch (e) { /* fall through */ } }
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a !== -1 && b > a) { try { return JSON.parse(text.slice(a, b + 1)); } catch (e) { /* fall through */ } }
  return null;
}

/* ---------- /api/analyze ---------- */
async function analyze(req, res) {
  if (!/^image\/jpeg\b/i.test(req.headers['content-type'] || '')) return fail(res, 415, 'unsupported');
  const tooBig = () => {
    // answer first, then drop the connection so a huge upload stops streaming in
    res.setHeader('Connection', 'close');
    res.on('finish', () => req.destroy());
    return fail(res, 413, 'image_rejected');
  };
  if (Number(req.headers['content-length']) > MAX_BYTES) return tooBig();
  let buf;
  try { buf = await readBody(req); }
  catch (e) { return e.status === 413 ? tooBig() : fail(res, 400, 'image_rejected'); }
  if (buf.length < 1000 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return fail(res, 415, 'unsupported');

  if (!API_KEY) return fail(res, 503, 'not_configured');
  if (!ipAllowed(clientIp(req))) return fail(res, 429, 'rate_limited');
  if (!dayAllowed()) return fail(res, 429, 'daily_limit');

  let upstream;
  try {
    upstream = await fetch(API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: buf.toString('base64') } },
            { type: 'text', text: PROMPT }
          ]
        }]
      }),
      signal: AbortSignal.timeout(90e3)
    });
  } catch (e) {
    console.error('Anthropic request failed:', e && e.message);
    return fail(res, 502, 'upstream_error');
  }

  if (!upstream.ok) {
    const detail = (await upstream.text().catch(() => '')).slice(0, 300);
    console.error('Anthropic API error', upstream.status, detail);
    if (upstream.status === 401 || upstream.status === 403) return fail(res, 502, 'not_configured');
    if (upstream.status === 429 || upstream.status === 529) return fail(res, 503, 'busy');
    return fail(res, 502, 'upstream_error');
  }

  let data;
  try { data = await upstream.json(); } catch (e) { return fail(res, 502, 'invalid_json'); }
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const parsed = parseJson(text);
  if (!parsed || typeof parsed !== 'object') return fail(res, 502, 'invalid_json');
  return send(res, 200, parsed);
}

/* ---------- server ---------- */
const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (req.method === 'GET' && (url === '/' || url === '/index.html')) return send(res, 200, indexHtml, 'text/html; charset=utf-8');
  if (req.method === 'GET' && url === '/healthz') return send(res, 200, 'ok', 'text/plain; charset=utf-8');
  if (req.method === 'POST' && url === '/api/analyze') {
    analyze(req, res).catch((e) => { console.error(e); if (!res.headersSent) fail(res, 500, 'upstream_error'); });
    return;
  }
  fail(res, 404, 'not_found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('Plate Lens on port ' + PORT + ' | model ' + MODEL + ' | key ' + (API_KEY ? 'set' : 'MISSING') + ' | limits ' + PER_IP_HOUR + '/hour per visitor, ' + PER_DAY + '/day total');
});
