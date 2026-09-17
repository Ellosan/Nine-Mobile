'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { startMockServer, chunkOf } = require('./mockServer');
const {
  streamChatCompletion,
  listModels,
  apiUrl,
  normalizeBaseUrl,
  ApiError,
} = require('../.test-build/api/openai');

const fetchImpl = (url, init) => fetch(url, init);

function textPlan(words) {
  return {
    mode: 'text',
    chunks: [
      chunkOf({ role: 'assistant', content: '' }),
      ...words.map((w) => chunkOf({ content: w })),
      chunkOf({}, 'stop'),
    ],
  };
}

test('streams text deltas and accumulates the final message', async () => {
  const srv = await startMockServer({ handler: () => textPlan(['Hello', ', ', 'world', '!']) });
  try {
    const deltas = [];
    let opened = false;
    const res = await streamChatCompletion(
      {
        baseUrl: srv.baseUrl,
        apiKey: 'sk-test',
        model: 'test-model',
        messages: [{ role: 'user', content: 'hi' }],
        fetchImpl,
      },
      {
        onOpen: () => (opened = true),
        onText: (d) => deltas.push(d),
      }
    );
    assert.strictEqual(opened, true);
    assert.deepStrictEqual(deltas, ['Hello', ', ', 'world', '!']);
    assert.strictEqual(res.content, 'Hello, world!');
    assert.strictEqual(res.finishReason, 'stop');
    assert.strictEqual(res.toolCalls.length, 0);
    assert.strictEqual(res.model, 'test-model');
  } finally {
    await srv.close();
  }
});

test('sends the right request shape, auth header and stream flag', async () => {
  const srv = await startMockServer({ handler: () => textPlan(['ok']) });
  try {
    await streamChatCompletion({
      baseUrl: srv.baseUrl,
      apiKey: 'sk-secret',
      model: 'my-model',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.3,
      maxTokens: 256,
      fetchImpl,
    });
    const req = srv.state.requests.at(-1);
    assert.strictEqual(req.url, '/v1/chat/completions');
    assert.strictEqual(req.headers.authorization, 'Bearer sk-secret');
    assert.strictEqual(req.body.stream, true);
    assert.strictEqual(req.body.model, 'my-model');
    assert.strictEqual(req.body.temperature, 0.3);
    assert.strictEqual(req.body.max_tokens, 256);
    assert.strictEqual(req.body.tools, undefined);
  } finally {
    await srv.close();
  }
});

test('accumulates a tool call whose JSON arguments arrive in fragments', async () => {
  const srv = await startMockServer({
    handler: () => ({
      mode: 'text',
      chunks: [
        chunkOf({ role: 'assistant', content: null }),
        chunkOf({
          tool_calls: [
            { index: 0, id: 'call_abc', type: 'function', function: { name: 'read_', arguments: '' } },
          ],
        }),
        chunkOf({ tool_calls: [{ index: 0, function: { name: 'file', arguments: '{"pa' } }] }),
        chunkOf({ tool_calls: [{ index: 0, function: { arguments: 'th":"src/' } }] }),
        chunkOf({ tool_calls: [{ index: 0, function: { arguments: 'a.ts"}' } }] }),
        chunkOf({}, 'tool_calls'),
      ],
    }),
  });
  try {
    const res = await streamChatCompletion({
      baseUrl: srv.baseUrl,
      apiKey: 'k',
      model: 'm',
      messages: [{ role: 'user', content: 'read it' }],
      fetchImpl,
    });
    assert.strictEqual(res.finishReason, 'tool_calls');
    assert.strictEqual(res.toolCalls.length, 1);
    const tc = res.toolCalls[0];
    assert.strictEqual(tc.id, 'call_abc');
    assert.strictEqual(tc.function.name, 'read_file');
    assert.deepStrictEqual(JSON.parse(tc.function.arguments), { path: 'src/a.ts' });
  } finally {
    await srv.close();
  }
});

test('accumulates two parallel tool calls in stream order', async () => {
  const srv = await startMockServer({
    handler: () => ({
      mode: 'text',
      chunks: [
        chunkOf({
          tool_calls: [
            { index: 0, id: 'c0', type: 'function', function: { name: 'read_file', arguments: '{}' } },
            { index: 1, id: 'c1', type: 'function', function: { name: 'write_file', arguments: '' } },
          ],
        }),
        chunkOf({ tool_calls: [{ index: 1, function: { arguments: '{"path":"x"}' } }] }),
        chunkOf({}, 'tool_calls'),
      ],
    }),
  });
  try {
    const res = await streamChatCompletion({
      baseUrl: srv.baseUrl,
      apiKey: 'k',
      model: 'm',
      messages: [],
      fetchImpl,
    });
    assert.deepStrictEqual(res.toolCalls.map((t) => t.function.name), ['read_file', 'write_file']);
    assert.strictEqual(res.toolCalls[1].function.arguments, '{"path":"x"}');
  } finally {
    await srv.close();
  }
});

test('passes tools through and sets tool_choice', async () => {
  const srv = await startMockServer({ handler: () => textPlan(['x']) });
  try {
    await streamChatCompletion({
      baseUrl: srv.baseUrl,
      apiKey: 'k',
      model: 'm',
      messages: [],
      tools: [
        {
          type: 'function',
          function: { name: 'read_file', description: 'd', parameters: { type: 'object' } },
        },
      ],
      fetchImpl,
    });
    const req = srv.state.requests.at(-1);
    assert.strictEqual(req.body.tools.length, 1);
    assert.strictEqual(req.body.tool_choice, 'auto');
  } finally {
    await srv.close();
  }
});

test('falls back cleanly when the server ignores stream:true', async () => {
  const srv = await startMockServer({
    handler: () => ({
      mode: 'json',
      payload: {
        model: 'non-streaming',
        choices: [{ index: 0, message: { role: 'assistant', content: 'full answer' }, finish_reason: 'stop' }],
        usage: { total_tokens: 12 },
      },
    }),
  });
  try {
    const seen = [];
    const res = await streamChatCompletion(
      { baseUrl: srv.baseUrl, apiKey: 'k', model: 'm', messages: [], fetchImpl },
      { onText: (d) => seen.push(d) }
    );
    assert.strictEqual(res.content, 'full answer');
    assert.strictEqual(res.finishReason, 'stop');
    assert.deepStrictEqual(seen, ['full answer']);
    assert.deepStrictEqual(res.usage, { total_tokens: 12 });
  } finally {
    await srv.close();
  }
});

test('throws ApiError carrying status and body on a 401', async () => {
  const srv = await startMockServer({
    handler: () => ({ mode: 'error', status: 401, message: 'Invalid API key' }),
  });
  try {
    await assert.rejects(
      () =>
        streamChatCompletion({
          baseUrl: srv.baseUrl,
          apiKey: 'wrong',
          model: 'm',
          messages: [],
          fetchImpl,
        }),
      (err) => {
        assert.ok(err instanceof ApiError);
        assert.strictEqual(err.status, 401);
        assert.match(err.body, /Invalid API key/);
        return true;
      }
    );
  } finally {
    await srv.close();
  }
});

test('aborts an in-flight stream', async () => {
  const srv = await startMockServer({
    handler: () => ({ ...textPlan(Array(400).fill('tok ')), sliceSize: 3 }),
  });
  try {
    const ac = new AbortController();
    const p = streamChatCompletion(
      { baseUrl: srv.baseUrl, apiKey: 'k', model: 'm', messages: [], signal: ac.signal, fetchImpl },
      { onText: () => ac.abort() }
    );
    await assert.rejects(p);
  } finally {
    await srv.close();
  }
});

test('lists models', async () => {
  const srv = await startMockServer({});
  try {
    const models = await listModels({ baseUrl: srv.baseUrl, apiKey: 'k', fetchImpl });
    assert.deepStrictEqual(models.map((m) => m.id), ['test-model', 'other']);
  } finally {
    await srv.close();
  }
});

test('normalises base URLs the way a user might type them', () => {
  assert.strictEqual(normalizeBaseUrl('  192.168.1.5:20128  '), 'http://192.168.1.5:20128');
  assert.strictEqual(normalizeBaseUrl('http://h:20128/v1/'), 'http://h:20128/v1');
  assert.strictEqual(normalizeBaseUrl('https://api.openai.com/v1'), 'https://api.openai.com/v1');

  // /v1 already present -> not doubled
  assert.strictEqual(apiUrl('http://h:20128/v1', '/chat/completions'), 'http://h:20128/v1/chat/completions');
  // /v1 missing -> added
  assert.strictEqual(apiUrl('http://h:20128', '/chat/completions'), 'http://h:20128/v1/chat/completions');
  // no scheme -> http assumed
  assert.strictEqual(apiUrl('h:20128', '/models'), 'http://h:20128/v1/models');
  // full endpoint pasted -> left alone
  assert.strictEqual(
    apiUrl('http://h:20128/v1/chat/completions', '/chat/completions'),
    'http://h:20128/v1/chat/completions'
  );
});
