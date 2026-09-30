import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  COPILOT_HOOK_EVENTS,
  normalizeCopilotHook,
  withoutCopilotLaunchArgs,
  writeCopilotPlugin,
} from '../src/server/copilot.js';
import { isValidCopilotModel, validateWorkerEffort, validateWorkerModel } from '../src/server/agents.js';
import { writeCopilotMcpConfig } from '../src/server/office-workers.js';

test('normalizes bounded Copilot hook payloads', () => {
  assert.deepEqual(normalizeCopilotHook('sessionStart', {
    sessionId: 'sess-1', source: 'new', initialPrompt: 'secret', cwd: '/x',
  }), { sessionId: 'sess-1', event: 'sessionStart', source: 'new' });
  assert.deepEqual(normalizeCopilotHook('userPromptSubmitted', {
    sessionId: 'sess-1', prompt: '  fix the login  ',
  }), { sessionId: 'sess-1', event: 'userPromptSubmitted', prompt: 'fix the login' });
  assert.deepEqual(normalizeCopilotHook('preToolUse', {
    sessionId: 'sess-1', toolName: 'bash', toolArgs: { command: 'secret' },
  }), { sessionId: 'sess-1', event: 'preToolUse', tool: 'bash' });
  assert.deepEqual(normalizeCopilotHook('permissionRequest', {
    sessionId: 'sess-1', toolName: 'bash', toolInput: { command: 'secret' },
  }), { sessionId: 'sess-1', event: 'permissionRequest', tool: 'bash' });
  assert.deepEqual(normalizeCopilotHook('notification', {
    sessionId: 'sess-1', notification_type: 'permission_prompt', message: 'secret',
  }), { sessionId: 'sess-1', event: 'notification', notificationType: 'permission_prompt' });
  assert.deepEqual(normalizeCopilotHook('agentStop', {
    sessionId: 'sess-1', stopReason: 'end_turn', transcriptPath: '/secret',
  }), { sessionId: 'sess-1', event: 'agentStop', reason: 'end_turn' });
});

test('rejects unknown, malformed, empty, oversized, and child-scoped Copilot events', () => {
  assert.equal(normalizeCopilotHook('Unknown', { sessionId: 'x' }), undefined);
  assert.equal(normalizeCopilotHook('agentStop', null), undefined);
  assert.equal(normalizeCopilotHook('agentStop', { sessionId: '' }), undefined);
  assert.equal(normalizeCopilotHook('agentStop', { sessionId: 'x'.repeat(161) }), undefined);
  assert.equal(normalizeCopilotHook('agentStop', { sessionId: 'x', agent_id: 'child-1' }), undefined);
});

test('strips launch flags the office always sets itself', () => {
  assert.deepEqual(
    withoutCopilotLaunchArgs(['--keep', 'yes', '--model', 'old', '--session-id', 'abc', '--resume=xyz', '--reasoning-effort=high', '--plugin-dir', '/p', '-i', 'hello', '--continue']),
    ['--keep', 'yes'],
  );
});

test('writes a plugin whose hooks run the helper without a shell', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-office-copilot-'));
  try {
    const written = writeCopilotPlugin(dir);
    assert.equal(written.dir, path.join(dir, 'copilot-plugin'));
    const source = readFileSync(written.hook, 'utf8');
    assert.match(source, /MAX = 64 \* 1024/);
    assert.match(source, /AGENT_OFFICE_HOOK_TOKEN/);
    assert.doesNotMatch(source, /readFile|readSync|createReadStream/);
    assert.equal(JSON.parse(readFileSync(path.join(written.dir, 'plugin.json'), 'utf8')).name, 'agent-office');
    const config = JSON.parse(readFileSync(path.join(written.dir, 'hooks.json'), 'utf8')) as { version: number; hooks: Record<string, { type: string; exec: string; args: string[] }[]> };
    assert.equal(config.version, 1);
    for (const event of COPILOT_HOOK_EVENTS) {
      assert.deepEqual(config.hooks[event].map((h) => [h.type, h.exec, h.args]), [['command', process.execPath, [written.hook, event]]]);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writes the MCP config Copilot adds to its own', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-office-copilot-'));
  try {
    const file = writeCopilotMcpConfig(dir, '/office/bin/office-workers.js');
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
      mcpServers: { 'agent-office': { type: 'local', command: process.execPath, args: ['/office/bin/office-workers.js', 'mcp'], tools: ['*'] } },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validates Copilot models and efforts', () => {
  assert.equal(isValidCopilotModel('claude-sonnet-4.5'), true);
  assert.equal(isValidCopilotModel('auto'), true);
  assert.equal(isValidCopilotModel('--evil'), false);
  assert.equal(isValidCopilotModel('two words'), false);
  assert.equal(isValidCopilotModel('x'.repeat(129)), false);
  assert.equal(validateWorkerModel('agent', 'copilot', 'gpt-5'), undefined);
  assert.match(validateWorkerModel('agent', 'copilot', '-x') ?? '', /Invalid Copilot model/);
  assert.equal(validateWorkerEffort('agent', 'copilot', 'high'), undefined);
});

test('helper forwards only the bounded event fields to the authenticated bridge', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-office-copilot-'));
  const received: { url?: string; authorization?: string; body?: unknown } = {};
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.url = req.url;
      received.authorization = req.headers.authorization;
      received.body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200).end();
    });
  });
  try {
    const { hook } = writeCopilotPlugin(dir);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const child = spawn(process.execPath, [hook, 'userPromptSubmitted'], {
      env: {
        PATH: process.env.PATH,
        AGENT_OFFICE_HOOK_URL: `http://127.0.0.1:${address.port}`,
        AGENT_OFFICE_HOOK_TOKEN: 'hook-token',
        AGENT_OFFICE_WORKER_ID: 'worker-1',
      },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const stdout = await new Promise<string>((resolve, reject) => {
      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.on('error', reject);
      child.on('close', () => resolve(output));
      child.stdin.end(JSON.stringify({
        sessionId: 'sess-1', prompt: 'fix it', toolArgs: { command: 'private' }, cwd: '/private',
      }));
    });
    // Copilot reads a hook's stdout as a decision, so the helper says nothing.
    assert.equal(stdout, '');
    assert.equal(received.authorization, 'Bearer hook-token');
    assert.equal(received.url, '/hooks/copilot?worker=worker-1&event=userPromptSubmitted');
    assert.deepEqual(received.body, { sessionId: 'sess-1', prompt: 'fix it' });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
