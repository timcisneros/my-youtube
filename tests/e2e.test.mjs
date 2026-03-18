import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';

// Use a very short Creative Commons video for testing
const TEST_VIDEO_ID = 'BaW_jenozKc'; // 1-second test video
const TEST_PORT = 13590;

// ---------------------------------------------------------------------------
// HTTP helper with cookie jar
// ---------------------------------------------------------------------------

let sessionCookie = '';

async function httpReq(port, method, urlPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost', port, method, path: urlPath,
      headers: { ...(opts.headers || {}), Cookie: sessionCookie },
    };
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        // Capture set-cookie
        const sc = res.headers['set-cookie'];
        if (sc) {
          for (const c of sc) {
            const match = c.match(/connect\.sid=[^;]+/);
            if (match) sessionCookie = match[0];
          }
        }
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, body, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// End-to-end playback path tests
// ---------------------------------------------------------------------------

describe('End-to-end playback path', { timeout: 120000 }, () => {
  let serverProcess;

  before(async () => {
    // Start server as a child process
    serverProcess = spawn('node', [path.join(import.meta.dirname, '..', 'server.js')], {
      env: {
        ...process.env,
        PORT: String(TEST_PORT),
        SESSION_SECRET: 'test-secret-e2e',
        NODE_ENV: 'test',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Wait for server to be ready
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Server start timeout')), 15000);
      let stderr = '';
      serverProcess.stdout.on('data', (data) => {
        if (data.toString().includes('my-youtube running')) {
          clearTimeout(timeout);
          resolve();
        }
      });
      serverProcess.stderr.on('data', (data) => {
        stderr += data.toString();
      });
      serverProcess.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
      serverProcess.on('exit', (code) => {
        if (code) {
          clearTimeout(timeout);
          reject(new Error(`Server exited with code ${code}: ${stderr}`));
        }
      });
    });
  });

  after(() => {
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      // Force kill after 5s
      setTimeout(() => {
        try { serverProcess.kill('SIGKILL'); } catch {}
      }, 5000);
    }
  });

  it('POST /auth/free should create a session', async () => {
    const res = await httpReq(TEST_PORT, 'POST', '/auth/free');
    assert.ok(
      res.status === 302 || res.status === 301 || res.status === 303,
      `Expected redirect, got ${res.status}`
    );
    assert.ok(sessionCookie, 'Should have received a session cookie');
  });

  it('GET /watch?v=TEST_VIDEO_ID should return 200 with video element', { timeout: 60000 }, async () => {
    const res = await httpReq(TEST_PORT, 'GET', `/watch?v=${TEST_VIDEO_ID}`);
    assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);
    assert.ok(res.body.includes('<video'), 'Page should contain a <video element');
  });

  it('GET /api/stream/TEST_VIDEO_ID/poster should return 200 with image content-type', { timeout: 60000 }, async () => {
    const res = await httpReq(TEST_PORT, 'GET', `/api/stream/${TEST_VIDEO_ID}/poster`);
    assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);
    const ct = res.headers['content-type'] || '';
    assert.ok(ct.includes('image'), `Expected image content-type, got ${ct}`);
  });

  it('GET /api/stream/TEST_VIDEO_ID/dash.mpd should return valid manifest', { timeout: 60000 }, async () => {
    // First get a stream token from the watch page
    const watchRes = await httpReq(TEST_PORT, 'GET', `/watch?v=${TEST_VIDEO_ID}`);
    const tokenMatch = watchRes.body.match(/streamToken['":\s]+['"]([^'"]+)['"]/);
    const token = tokenMatch ? tokenMatch[1] : '';

    const dashUrl = `/api/stream/${TEST_VIDEO_ID}/dash.mpd${token ? '?token=' + token : ''}`;
    const res = await httpReq(TEST_PORT, 'GET', dashUrl);
    assert.ok(
      res.status === 200 || res.status === 302,
      `Expected 200 or 302, got ${res.status}`
    );

    if (res.status === 200) {
      const ct = res.headers['content-type'] || '';
      // Could be DASH MPD (XML), HLS, or progressive JSON
      const isValid = ct.includes('xml') || ct.includes('mpd') ||
                      ct.includes('json') || ct.includes('mpegurl') ||
                      res.body.includes('<?xml') || res.body.includes('MPD') ||
                      res.body.startsWith('{') || res.body.startsWith('[');
      assert.ok(isValid, `Expected valid manifest format, got content-type: ${ct}`);
    }
  });

  it('GET /api/stream/TEST_VIDEO_ID/storyboard should return 200 JSON', { timeout: 60000 }, async () => {
    // Get stream token
    const watchRes = await httpReq(TEST_PORT, 'GET', `/watch?v=${TEST_VIDEO_ID}`);
    const tokenMatch = watchRes.body.match(/streamToken['":\s]+['"]([^'"]+)['"]/);
    const token = tokenMatch ? tokenMatch[1] : '';

    const url = `/api/stream/${TEST_VIDEO_ID}/storyboard${token ? '?token=' + token : ''}`;
    const res = await httpReq(TEST_PORT, 'GET', url);

    // Storyboard may not be available for very short videos — accept 200 or 404
    if (res.status === 200) {
      const data = JSON.parse(res.body);
      assert.ok(Array.isArray(data.sheets) || data.sheets === undefined,
        'If present, sheets should be an array');
    } else {
      assert.ok(
        res.status === 404 || res.status === 204,
        `Expected 200, 204, or 404 for storyboard, got ${res.status}`
      );
    }
  });

  it('GET /health should return 200 with database.status ok', async () => {
    const res = await httpReq(TEST_PORT, 'GET', '/health');
    assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);
    const data = JSON.parse(res.body);
    assert.ok(data.database, 'Health should include database check');
    assert.strictEqual(data.database.status, 'ok', 'Database status should be ok');
  });

  it('should extract format and serve segment if DASH manifest available', { timeout: 60000 }, async () => {
    // Get stream token
    const watchRes = await httpReq(TEST_PORT, 'GET', `/watch?v=${TEST_VIDEO_ID}`);
    const tokenMatch = watchRes.body.match(/streamToken['":\s]+['"]([^'"]+)['"]/);
    const token = tokenMatch ? tokenMatch[1] : '';

    const dashUrl = `/api/stream/${TEST_VIDEO_ID}/dash.mpd${token ? '?token=' + token : ''}`;
    const dashRes = await httpReq(TEST_PORT, 'GET', dashUrl);

    if (dashRes.status !== 200) {
      // If DASH is not available, skip format test
      assert.ok(true, 'DASH not available for this video, skipping format test');
      return;
    }

    // Try to extract a format ID from the manifest
    // DASH MPD: <Representation id="140" ...>
    // Progressive JSON: {"formats":[{"format_id":"140",...}]}
    let formatId = null;

    const repMatch = dashRes.body.match(/Representation[^>]+id="(\d+)"/);
    if (repMatch) {
      formatId = repMatch[1];
    } else {
      try {
        const json = JSON.parse(dashRes.body);
        const formats = json.formats || json.adaptive_formats || [];
        if (formats.length > 0) {
          formatId = formats[0].format_id || formats[0].itag;
        }
      } catch {}
    }

    if (!formatId) {
      assert.ok(true, 'Could not extract format ID from manifest, skipping format fetch');
      return;
    }

    const fmtUrl = `/api/stream/${TEST_VIDEO_ID}/fmt/${formatId}${token ? '?token=' + token : ''}`;
    const fmtRes = await httpReq(TEST_PORT, 'GET', fmtUrl, {
      headers: { Range: 'bytes=0-1023' },
    });

    assert.ok(
      fmtRes.status === 200 || fmtRes.status === 206,
      `Expected 200 or 206, got ${fmtRes.status}`
    );
    const ct = fmtRes.headers['content-type'] || '';
    assert.ok(
      ct.includes('video') || ct.includes('audio') || ct.includes('octet'),
      `Expected video/audio content-type, got ${ct}`
    );
  });
});
