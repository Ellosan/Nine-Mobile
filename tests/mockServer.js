'use strict';
/**
 * A tiny OpenAI-compatible server used by the test-suite. It speaks the same
 * SSE framing that 9router / OpenAI / vLLM emit, including the awkward bits
 * (chunk boundaries mid-JSON, ": ping" heartbeats, a final [DONE]).
 */
const http = require('node:http');

function sseFrame(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function chunkOf(delta, finish = null, extra = {}) {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: 1700000000,
    model: 'test-model',
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...extra,
  };
}

/**
 * @param {object} opts
 * @param {(body:object)=>object} opts.handler returns {mode, ...}
 */
function startMockServer(opts = {}) {
  const state = { requests: [] };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', async () => {
      let body = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        /* ignore */
      }
      state.requests.push({
        url: req.url,
        method: req.method,
        headers: req.headers,
        body,
      });

      if (req.url.endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'test-model' }, { id: 'other' }] }));
        return;
      }

      const plan = opts.handler ? opts.handler(body, state) : { mode: 'text', text: 'hi' };

      if (plan.mode === 'error') {
        res.writeHead(plan.status || 401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: plan.message || 'bad key' } }));
        return;
      }

      if (plan.mode === 'json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(plan.payload));
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      // Build the full SSE byte string first, then dribble it out in awkward
      // slices so the parser is exercised across chunk boundaries.
      let payload = ': ping\n\n';
      for (const c of plan.chunks) payload += sseFrame(c);
      payload += 'data: [DONE]\n\n';

      const size = plan.sliceSize || 7;
      for (let i = 0; i < payload.length; i += size) {
        res.write(payload.slice(i, i + size));
        await new Promise((r) => setTimeout(r, 0));
      }
      res.end();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        state,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

module.exports = { startMockServer, chunkOf };
