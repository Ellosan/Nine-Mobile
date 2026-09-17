'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { startMockServer, chunkOf } = require('./mockServer');
const { runAgentTurn } = require('../.test-build/agent/loop');
const { toolsFor } = require('../.test-build/agent/toolSchemas');

const fetchImpl = (url, init) => fetch(url, init);
const TOOLS = toolsFor({ fileTools: true, shellTool: true });

function toolCallPlan(name, args, id = 'call_1') {
  return {
    mode: 'text',
    chunks: [
      chunkOf({ role: 'assistant', content: null }),
      chunkOf({
        tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: args } }],
      }),
      chunkOf({}, 'tool_calls'),
    ],
  };
}

function textPlan(text) {
  return {
    mode: 'text',
    chunks: [chunkOf({ role: 'assistant', content: text }), chunkOf({}, 'stop')],
  };
}

/** Records every tool invocation and returns canned results. */
function makeExecutor(results = {}) {
  const calls = [];
  return {
    calls,
    execute: async (call) => {
      calls.push({ name: call.function.name, args: JSON.parse(call.function.arguments || '{}') });
      const r = results[call.function.name];
      if (typeof r === 'function') return r(call);
      return r ?? { ok: true, content: 'done' };
    },
  };
}

function makeGate(decisions) {
  const asked = [];
  const queue = Array.isArray(decisions) ? [...decisions] : null;
  return {
    asked,
    request: async (call) => {
      asked.push(call.function.name);
      if (queue) return queue.shift() ?? 'deny';
      return decisions;
    },
  };
}

function baseOpts(srv, overrides) {
  return {
    baseUrl: srv.baseUrl,
    apiKey: 'k',
    model: 'm',
    messages: [{ role: 'user', content: 'go' }],
    tools: TOOLS,
    fetchImpl,
    onEvent: () => {},
    ...overrides,
  };
}

test('read_file: executes without prompting and feeds the result back', async () => {
  let n = 0;
  const srv = await startMockServer({
    handler: () => (n++ === 0 ? toolCallPlan('read_file', '{"path":"a.txt"}') : textPlan('The file says hello.')),
  });
  try {
    const executor = makeExecutor({ read_file: { ok: true, content: 'hello' } });
    const gate = makeGate('deny'); // must never be consulted for a read
    const events = [];

    const res = await runAgentTurn(
      baseOpts(srv, { executor, permissions: gate, onEvent: (e) => events.push(e.type) })
    );

    assert.strictEqual(res.reason, 'stop');
    assert.strictEqual(res.iterations, 2);
    assert.deepStrictEqual(gate.asked, [], 'read_file must not trigger a permission prompt');
    assert.deepStrictEqual(executor.calls, [{ name: 'read_file', args: { path: 'a.txt' } }]);

    // assistant(tool_calls) -> tool result -> assistant(text)
    assert.deepStrictEqual(res.newMessages.map((m) => m.role), ['assistant', 'tool', 'assistant']);
    assert.strictEqual(res.newMessages[0].tool_calls[0].function.name, 'read_file');
    assert.strictEqual(res.newMessages[1].tool_call_id, 'call_1');
    assert.strictEqual(res.newMessages[1].content, 'hello');
    assert.strictEqual(res.newMessages[2].content, 'The file says hello.');

    assert.ok(events.includes('tool_start'));
    assert.ok(events.includes('tool_result'));
    assert.ok(events.includes('turn_complete'));
  } finally {
    await srv.close();
  }
});

test('the tool result is actually sent back to the server on the next request', async () => {
  let n = 0;
  const srv = await startMockServer({
    handler: () => (n++ === 0 ? toolCallPlan('read_file', '{"path":"a.txt"}') : textPlan('ok')),
  });
  try {
    await runAgentTurn(
      baseOpts(srv, {
        executor: makeExecutor({ read_file: { ok: true, content: 'FILE-BODY-42' } }),
        permissions: makeGate('allow'),
      })
    );
    const second = srv.state.requests.at(-1).body;
    const toolMsg = second.messages.find((m) => m.role === 'tool');
    assert.ok(toolMsg, 'second request must include the tool result message');
    assert.strictEqual(toolMsg.content, 'FILE-BODY-42');
    assert.strictEqual(toolMsg.tool_call_id, 'call_1');
    const asst = second.messages.find((m) => m.role === 'assistant');
    assert.strictEqual(asst.tool_calls.length, 1);
  } finally {
    await srv.close();
  }
});

test('write_file prompts for permission and runs when allowed', async () => {
  let n = 0;
  const srv = await startMockServer({
    handler: () =>
      n++ === 0 ? toolCallPlan('write_file', '{"path":"b.txt","content":"x"}') : textPlan('Written.'),
  });
  try {
    const executor = makeExecutor({ write_file: { ok: true, content: 'wrote 1 byte' } });
    const gate = makeGate('allow');
    const res = await runAgentTurn(baseOpts(srv, { executor, permissions: gate }));

    assert.deepStrictEqual(gate.asked, ['write_file']);
    assert.strictEqual(executor.calls.length, 1);
    assert.strictEqual(res.newMessages[1].content, 'wrote 1 byte');
    assert.strictEqual(res.reason, 'stop');
  } finally {
    await srv.close();
  }
});

test('a denied write_file never reaches the executor and tells the model so', async () => {
  let n = 0;
  const srv = await startMockServer({
    handler: () =>
      n++ === 0 ? toolCallPlan('write_file', '{"path":"b.txt","content":"x"}') : textPlan('Understood.'),
  });
  try {
    const executor = makeExecutor();
    const gate = makeGate('deny');
    const res = await runAgentTurn(baseOpts(srv, { executor, permissions: gate }));

    assert.deepStrictEqual(gate.asked, ['write_file']);
    assert.strictEqual(executor.calls.length, 0, 'executor must not run on denial');
    assert.match(res.newMessages[1].content, /DENIED/);
    assert.strictEqual(res.newMessages[1].role, 'tool');
    assert.strictEqual(res.reason, 'stop');
  } finally {
    await srv.close();
  }
});

test('run_shell_command is gated too', async () => {
  let n = 0;
  const srv = await startMockServer({
    handler: () => (n++ === 0 ? toolCallPlan('run_shell_command', '{"command":"ls"}') : textPlan('done')),
  });
  try {
    const gate = makeGate('deny');
    await runAgentTurn(baseOpts(srv, { executor: makeExecutor(), permissions: gate }));
    assert.deepStrictEqual(gate.asked, ['run_shell_command']);
  } finally {
    await srv.close();
  }
});

test('"allow for session" suppresses the prompt on later calls of the same tool', async () => {
  let n = 0;
  const srv = await startMockServer({
    handler: () => {
      const i = n++;
      if (i === 0) return toolCallPlan('write_file', '{"path":"1.txt","content":"a"}', 'c1');
      if (i === 1) return toolCallPlan('write_file', '{"path":"2.txt","content":"b"}', 'c2');
      return textPlan('Both written.');
    },
  });
  try {
    const executor = makeExecutor({ write_file: { ok: true, content: 'ok' } });
    const gate = makeGate(['allow_session']);
    const res = await runAgentTurn(baseOpts(srv, { executor, permissions: gate }));

    assert.deepStrictEqual(gate.asked, ['write_file'], 'should only be asked once');
    assert.strictEqual(executor.calls.length, 2);
    assert.strictEqual(res.iterations, 3);
    assert.strictEqual(res.reason, 'stop');
  } finally {
    await srv.close();
  }
});

test('runs several tool calls from one assistant turn in order', async () => {
  let n = 0;
  const srv = await startMockServer({
    handler: () =>
      n++ === 0
        ? {
            mode: 'text',
            chunks: [
              chunkOf({
                tool_calls: [
                  { index: 0, id: 'a', type: 'function', function: { name: 'list_files', arguments: '{}' } },
                  {
                    index: 1,
                    id: 'b',
                    type: 'function',
                    function: { name: 'read_file', arguments: '{"path":"p"}' },
                  },
                ],
              }),
              chunkOf({}, 'tool_calls'),
            ],
          }
        : textPlan('surveyed'),
  });
  try {
    const executor = makeExecutor({
      list_files: { ok: true, content: 'p' },
      read_file: { ok: true, content: 'body' },
    });
    const res = await runAgentTurn(
      baseOpts(srv, { executor, permissions: makeGate('allow') })
    );
    assert.deepStrictEqual(executor.calls.map((c) => c.name), ['list_files', 'read_file']);
    assert.deepStrictEqual(res.newMessages.map((m) => m.role), ['assistant', 'tool', 'tool', 'assistant']);
    assert.deepStrictEqual(res.newMessages.slice(1, 3).map((m) => m.tool_call_id), ['a', 'b']);
  } finally {
    await srv.close();
  }
});

test('an executor failure is reported to the model, not thrown', async () => {
  let n = 0;
  const srv = await startMockServer({
    handler: () => (n++ === 0 ? toolCallPlan('read_file', '{"path":"nope"}') : textPlan('I see.')),
  });
  try {
    const executor = {
      calls: [],
      execute: async () => {
        throw new Error('disk on fire');
      },
    };
    const res = await runAgentTurn(baseOpts(srv, { executor, permissions: makeGate('allow') }));
    assert.strictEqual(res.reason, 'stop');
    assert.match(res.newMessages[1].content, /ERROR: disk on fire/);
  } finally {
    await srv.close();
  }
});

test('stops at maxIterations when the model never stops calling tools', async () => {
  const srv = await startMockServer({
    handler: () => toolCallPlan('read_file', '{"path":"loop"}'),
  });
  try {
    const executor = makeExecutor({ read_file: { ok: true, content: 'again' } });
    const res = await runAgentTurn(
      baseOpts(srv, { executor, permissions: makeGate('allow'), maxIterations: 3 })
    );
    assert.strictEqual(res.reason, 'max_iterations');
    assert.strictEqual(res.iterations, 3);
    assert.strictEqual(executor.calls.length, 3);
  } finally {
    await srv.close();
  }
});

test('surfaces an API error without throwing', async () => {
  const srv = await startMockServer({
    handler: () => ({ mode: 'error', status: 401, message: 'Invalid API key' }),
  });
  try {
    const errors = [];
    const res = await runAgentTurn(
      baseOpts(srv, {
        executor: makeExecutor(),
        permissions: makeGate('allow'),
        onEvent: (e) => e.type === 'error' && errors.push(e.error),
      })
    );
    assert.strictEqual(res.reason, 'error');
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /Invalid API key/);
  } finally {
    await srv.close();
  }
});

test('an aborted turn ends cleanly', async () => {
  const srv = await startMockServer({
    handler: () => toolCallPlan('read_file', '{"path":"x"}'),
  });
  try {
    const ac = new AbortController();
    const executor = {
      calls: [],
      execute: async () => {
        ac.abort();
        return { ok: true, content: 'partial' };
      },
    };
    const res = await runAgentTurn(
      baseOpts(srv, { executor, permissions: makeGate('allow'), signal: ac.signal })
    );
    assert.strictEqual(res.reason, 'aborted');
  } finally {
    await srv.close();
  }
});
