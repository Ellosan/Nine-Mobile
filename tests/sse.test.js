'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createSseParser } = require('../.test-build/api/sse');

function collect(chunks) {
  const events = [];
  const p = createSseParser((e) => events.push(e));
  for (const c of chunks) p.push(c);
  p.end();
  return events;
}

test('parses a simple event', () => {
  const e = collect(['data: hello\n\n']);
  assert.deepStrictEqual(e.map((x) => x.data), ['hello']);
  assert.strictEqual(e[0].event, 'message');
});

test('joins multi-line data with newlines', () => {
  const e = collect(['data: a\ndata: b\n\n']);
  assert.strictEqual(e[0].data, 'a\nb');
});

test('handles CRLF line endings', () => {
  const e = collect(['data: x\r\n\r\ndata: y\r\n\r\n']);
  assert.deepStrictEqual(e.map((x) => x.data), ['x', 'y']);
});

test('handles a \\r\\n split across two chunks', () => {
  const e = collect(['data: split\r', '\n\r\n']);
  assert.deepStrictEqual(e.map((x) => x.data), ['split']);
});

test('reassembles events split at arbitrary byte boundaries', () => {
  const src = 'data: {"a":1}\n\ndata: {"b":2}\n\n';
  for (let size = 1; size <= src.length; size++) {
    const parts = [];
    for (let i = 0; i < src.length; i += size) parts.push(src.slice(i, i + size));
    const e = collect(parts);
    assert.deepStrictEqual(
      e.map((x) => x.data),
      ['{"a":1}', '{"b":2}'],
      `failed at slice size ${size}`
    );
  }
});

test('ignores comments and heartbeats', () => {
  const e = collect([': ping\n\ndata: real\n\n']);
  assert.deepStrictEqual(e.map((x) => x.data), ['real']);
});

test('reads event/id/retry fields', () => {
  const e = collect(['event: custom\nid: 42\nretry: 1500\ndata: payload\n\n']);
  assert.strictEqual(e[0].event, 'custom');
  assert.strictEqual(e[0].id, '42');
  assert.strictEqual(e[0].retry, 1500);
});

test('does not dispatch field-less or data-less events', () => {
  assert.strictEqual(collect(['\n\n\n']).length, 0);
  assert.strictEqual(collect(['event: ping\n\n']).length, 0);
});

test('flushes a trailing event with no terminating blank line', () => {
  const e = collect(['data: tail']);
  assert.deepStrictEqual(e.map((x) => x.data), ['tail']);
});

test('strips exactly one leading space after the colon', () => {
  assert.strictEqual(collect(['data:  two-spaces\n\n'])[0].data, ' two-spaces');
  assert.strictEqual(collect(['data:nospace\n\n'])[0].data, 'nospace');
});
