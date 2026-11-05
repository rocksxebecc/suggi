/**
 * Zenspace Local Server
 * - Serves all static files (replaces `npx serve`)
 * - Proxies /api/math → Groq so the API key never reaches the browser
 */

const http    = require('http');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const url     = require('url');

// ── Load .env manually (no dependencies needed) ───────────────
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const [key, ...rest] = line.split('=');
    if (key && rest.length) process.env[key.trim()] = rest.join('=').trim();
  });
}

const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const HF_TOKEN     = process.env.HF_TOKEN || '';
const POLLINATIONS_API_KEY = process.env.POLLINATIONS_API_KEY || '';
const PORT         = process.env.PORT || 3000;

// ── MIME types ─────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.mp4':  'video/mp4',
  '.webm': 'video/webm',
};

// ── Proxy request to Groq ──────────────────────────────────────
function proxyMath(req, res) {
  if (!GROQ_API_KEY) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'GROQ_API_KEY not set in .env file on the server.' } }));
    return;
  }

  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    const options = {
      hostname: 'api.groq.com',
      path:     '/openai/v1/chat/completions',
      method:   'POST',
      headers:  {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const proxy = https.request(options, groqRes => {
      res.writeHead(groqRes.statusCode, { 'Content-Type': 'application/json' });
      groqRes.pipe(res);
    });
    proxy.on('error', err => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `Proxy error: ${err.message}` } }));
    });
    proxy.write(body);
    proxy.end();
  });
}

// ── AI Image Generation via Pollinations.ai (no rate-limited model params) ──
// Fetches image server-side so we can strip the watermark by cropping.
function generatePhotorealisticImage(prompt, modelStyle) {
  return new Promise((resolve, reject) => {
    const encoded = encodeURIComponent(prompt.trim());

    const candidates = [];
    if (POLLINATIONS_API_KEY) {
      candidates.push(`https://gen.pollinations.ai/image/${encoded}?key=${POLLINATIONS_API_KEY}&width=768&height=512&nologo=true`);
      candidates.push(`https://gen.pollinations.ai/image/${encoded}?key=${POLLINATIONS_API_KEY}&nologo=true`);
    }
    candidates.push(`https://image.pollinations.ai/prompt/${encoded}?width=768&height=512&nologo=true`);
    candidates.push(`https://image.pollinations.ai/prompt/${encoded}?nologo=true`);

    function fetchWithRedirects(urlStr, redirectsLeft, cb) {
      const u = new URL(urlStr);
      const mod = u.protocol === 'https:' ? https : require('http');
      const opts = {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
        }
      };
      const req = mod.request(opts, res => {
        if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
          req.abort && req.abort();
          return fetchWithRedirects(res.headers.location, redirectsLeft - 1, cb);
        }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          const ct  = res.headers['content-type'] || '';
          if (res.statusCode === 200 && ct.includes('image') && buf.byteLength > 2000) {
            cb(null, buf, ct);
          } else {
            let msg = `HTTP ${res.statusCode}`;
            try {
              const j = JSON.parse(buf.toString());
              if (j.error && j.error.message) msg = j.error.message;
            } catch(e) {}
            cb(new Error(msg));
          }
        });
      });
      req.on('error', cb);
      req.setTimeout(35000, () => { req.destroy(); cb(new Error('Image generation request timed out.')); });
      req.end();
    }

    let idx = 0;
    let lastErr = null;
    function tryNext() {
      if (idx >= candidates.length) {
        return reject(lastErr || new Error('Image generation server is currently busy. Please retry in a moment.'));
      }
      const url = candidates[idx++];
      fetchWithRedirects(url, 5, (err, buf, ct) => {
        if (err) {
          console.warn('[Zenspace] Image candidate failed:', err.message);
          lastErr = err;
          return tryNext();
        }
        const mime = ct.includes('png') ? 'image/png' : 'image/jpeg';
        resolve(`data:${mime};base64,${buf.toString('base64')}`);
      });
    }
    tryNext();
  });
}

function proxyImage(req, res) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    let parsed = {};
    try { parsed = JSON.parse(body); } catch (e) {}
    const prompt = parsed.prompt || '';
    const model = parsed.model || 'flux-realism';

    if (!prompt) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Prompt is required.' } }));
      return;
    }

    try {
      const imgUrl = await generatePhotorealisticImage(prompt, model);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, url: imgUrl }));
    } catch (err) {
      console.warn('[Zenspace] Image generator error:', err.message);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: err.message, retryAfter: null } }));
    }
  });
}


// ── Serve static files ─────────────────────────────────────────
function serveStatic(req, res) {
  let filePath = path.join(__dirname, url.parse(req.url).pathname);

  // Directory → index.html
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }
  // No extension → try .html
  if (!path.extname(filePath) && !fs.existsSync(filePath)) {
    filePath += '.html';
  }

  if (!fs.existsSync(filePath)) {
    res.writeHead(404); res.end('404 Not Found'); return;
  }

  const ext  = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime });
  fs.createReadStream(filePath).pipe(res);
}

// ── AI PDF → PPT slide structuring via Groq ───────────────────
function proxyPdf2Ppt(req, res) {
  if (!GROQ_API_KEY) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'GROQ_API_KEY not set in .env' }));
    return;
  }

  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    let parsed = {};
    try { parsed = JSON.parse(body); } catch (e) {}

    const fullRaw = (parsed.text || '').trim();
    const filename = parsed.filename || 'Document';
    const targetSlides = Math.min(Math.max(parsed.maxSlides || 12, 8), 25);

    if (!fullRaw) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No text provided from PDF' }));
      return;
    }

    // Smart document sampling: capture beginning, middle sections, and ending
    let textSample = fullRaw;
    if (fullRaw.length > 25000) {
      const partSize = 7500;
      const start = fullRaw.slice(0, partSize);
      const midIdx = Math.floor(fullRaw.length / 2) - Math.floor(partSize / 2);
      const mid = fullRaw.slice(midIdx, midIdx + partSize);
      const end = fullRaw.slice(-partSize);
      textSample = `${start}\n\n[... middle chapters ...]\n\n${mid}\n\n[... concluding chapters ...]\n\n${end}`;
    }

    const systemPrompt = `You are a world-class executive presentation designer and technical analyst.
Analyze the provided document thoroughly and generate a comprehensive, highly insightful PowerPoint presentation deck.

CRITICAL REQUIREMENTS:
1. Generate exactly ${targetSlides} slides covering the entire scope of the document:
   - Slide 1: Cover slide (layout: "title") with project title, subtitle/scope, and author/institution details.
   - Core slides: Problem Statement, Solution Overview, System Architecture, Core Features (deep-dive), Technical Implementation, Security/Data Policies, Results/Metrics, and Conclusion.
2. Structure every content slide with:
   - "category": Short 2-word uppercase domain pill (e.g. "SYSTEM ARCHITECTURE", "PROBLEM ANALYSIS", "CORE CAPABILITIES", "SECURITY & PRIVACY", "PERFORMANCE METRICS", "FUTURE SCOPE").
   - "title": Clear, descriptive heading.
   - "bullets": 3 to 4 high-value, comprehensive bullet points. Each bullet MUST follow the format "Headline – Detailed technical explanation, mechanism, or metric".
   - "imageTopic": Best matching visual topic from: "code", "ai", "data", "team", "security", "cloud", "study", "dashboard".
3. NEVER leave "bullets" empty. Do NOT use generic filler words like "Key Points". Use actual terms, frameworks, and metrics from the document text.

OUTPUT FORMAT: Return ONLY valid JSON matching this schema:
{
  "title": "Document Title",
  "slides": [
    {
      "layout": "title",
      "title": "Full Document Title",
      "subtitle": "Subject / Project Scope"
    },
    {
      "layout": "image-split",
      "category": "SYSTEM ARCHITECTURE",
      "title": "Multi-Tier Web Platform Architecture",
      "imageTopic": "code",
      "bullets": [
        "Presentation Tier – Responsive HTML5 and vanilla JavaScript dashboard with real-time UI state management",
        "Application Proxy – Node.js middleware server securing Groq AI endpoints and isolating credentials",
        "Storage & Auth Core – PostgreSQL relational database managed by Supabase with Row Level Security policies"
      ]
    }
  ]
}`;

    const userPrompt = `Document: ${filename}\n\nDOCUMENT CONTENT:\n${textSample}\n\nPerform a deep technical analysis and create an executive ${targetSlides}-slide presentation with concrete facts, mechanisms, and architectures from this text.`;

    const candidateModels = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b'];

    function callGroqModel(modelIdx) {
      if (modelIdx >= candidateModels.length) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'All AI models failed to generate presentation. Please check your Groq API key.' }));
        return;
      }

      const modelName = candidateModels[modelIdx];
      const payload = JSON.stringify({
        model: modelName,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt }
        ],
        temperature: 0.3,
        max_tokens: 5000,
        response_format: { type: 'json_object' }
      });

      const options = {
        hostname: 'api.groq.com',
        path:     '/openai/v1/chat/completions',
        method:   'POST',
        headers:  {
          'Content-Type':   'application/json',
          'Authorization':  `Bearer ${GROQ_API_KEY}`,
          'Content-Length': Buffer.byteLength(payload),
        },
      };

      const proxy = https.request(options, groqRes => {
        let data = '';
        groqRes.on('data', chunk => data += chunk);
        groqRes.on('end', () => {
          try {
            const groqJson = JSON.parse(data);
            if (groqJson.error) {
              console.warn(`[Zenspace PDF2PPT] Model ${modelName} error:`, groqJson.error.message);
              return callGroqModel(modelIdx + 1);
            }
            const content = groqJson.choices?.[0]?.message?.content || '';
            let parsedResult;
            try { parsedResult = JSON.parse(content); }
            catch (e) {
              const match = content.match(/\{[\s\S]*\}/);
              parsedResult = match ? JSON.parse(match[0]) : null;
            }

            if (!parsedResult || !Array.isArray(parsedResult.slides)) {
              console.warn(`[Zenspace PDF2PPT] Model ${modelName} returned invalid slides array:`, content.slice(0, 180));
              return callGroqModel(modelIdx + 1);
            }

            // Server-side normalization: guarantee non-empty titles and bullets
            const cleanedSlides = parsedResult.slides.map((s, idx) => {
              if (typeof s === 'string') {
                return { layout: idx === 0 ? 'title' : 'content', title: `Topic ${idx + 1}`, bullets: [s] };
              }
              const title = s.title || s.heading || s.header || (idx === 0 ? parsedResult.title : `Section ${idx + 1}`);
              let bullets = Array.isArray(s.bullets) ? s.bullets : (Array.isArray(s.points) ? s.points : (Array.isArray(s.items) ? s.items : []));
              bullets = bullets.filter(b => typeof b === 'string' && b.trim().length > 0);

              // If bullets still empty for content slide, extract from content or col1/col2
              if (idx > 0 && !bullets.length) {
                if (Array.isArray(s.col1) && s.col1.length) bullets = [...s.col1, ...(s.col2 || [])];
                else if (typeof s.content === 'string') bullets = [s.content];
                else if (typeof s.description === 'string') bullets = [s.description];
              }

              return {
                layout: idx === 0 ? 'title' : (s.layout || (s.col1?.length ? 'two-col' : 'content')),
                category: s.category || `SECTION ${String(idx).padStart(2, '0')}`,
                imageTopic: s.imageTopic || 'code',
                title: title || `Topic ${idx + 1}`,
                subtitle: s.subtitle || s.sub_title || '',
                bullets: bullets.length ? bullets : ['Key insight and findings from document analysis'],
                col1: Array.isArray(s.col1) ? s.col1 : [],
                col2: Array.isArray(s.col2) ? s.col2 : []
              };
            });

            console.log(`[Zenspace PDF2PPT] Successfully generated ${cleanedSlides.length} slides with ${modelName}`);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              title: parsedResult.title || filename.replace(/\.pdf$/i, ''),
              slides: cleanedSlides
            }));
          } catch (err) {
            console.warn(`[Zenspace PDF2PPT] Processing error on ${modelName}:`, err.message);
            return callGroqModel(modelIdx + 1);
          }
        });
      });

      proxy.on('error', err => {
        console.warn(`[Zenspace PDF2PPT] Request error on ${modelName}:`, err.message);
        callGroqModel(modelIdx + 1);
      });

      proxy.setTimeout(65000, () => {
        proxy.destroy();
        callGroqModel(modelIdx + 1);
      });

      proxy.write(payload);
      proxy.end();
    }

    callGroqModel(0);
  });
}

// ── Main server ────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  // CORS for local dev
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'POST' && req.url === '/api/math') {
    proxyMath(req, res);
  } else if (req.method === 'POST' && req.url === '/api/generate-image') {
    proxyImage(req, res);
  } else if (req.method === 'POST' && req.url === '/api/pdf2ppt') {
    proxyPdf2Ppt(req, res);
  } else {
    serveStatic(req, res);
  }
});

server.listen(PORT, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════╗');
  console.log('  ║        Zenspace Server Running           ║');
  console.log(`  ║   http://localhost:${PORT}                   ║`);
  console.log('  ╚══════════════════════════════════════════╝');
  console.log('');
  if (!GROQ_API_KEY) {
    console.log('  ⚠️  GROQ_API_KEY not set in .env — Math Agent will not work.');
    console.log('  ℹ️  Add it to .env: GROQ_API_KEY=gsk_...');
  } else {
    console.log('  ✅  Groq API key loaded — Math Agent ready!');
  }
  console.log('  ✅  Pollinations FLUX image generator ready!');
  console.log('');
});
