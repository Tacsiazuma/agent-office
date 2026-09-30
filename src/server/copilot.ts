import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Copilot CLI's hook events, spelled the way its hook config names them. */
export const COPILOT_HOOK_EVENTS = [
  'sessionStart',
  'userPromptSubmitted',
  'preToolUse',
  'postToolUse',
  'permissionRequest',
  'notification',
  'agentStop',
  'errorOccurred',
  'sessionEnd',
] as const;

export type CopilotHookEventName = (typeof COPILOT_HOOK_EVENTS)[number];

/** The bounded event shape forwarded to the worker bridge. */
export interface CopilotHookEvent {
  sessionId: string;
  event: CopilotHookEventName;
  source?: string;
  prompt?: string;
  tool?: string;
  notificationType?: string;
  reason?: string;
}

const MAX_ID = 160;
const MAX_TEXT = 20_000;
const EVENT_SET = new Set<string>(COPILOT_HOOK_EVENTS);

function bounded(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text && text.length <= max ? text : undefined;
}

function hasText(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function field(payload: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (payload[key] !== undefined) return payload[key];
  }
  return undefined;
}

/**
 * Validate and compact a Copilot hook payload. Child-agent events are ignored so a subagent's turn
 * cannot overwrite the desk's root status. Message bodies and tool arguments are discarded.
 */
export function normalizeCopilotHook(event: string, payload: unknown): CopilotHookEvent | undefined {
  if (!EVENT_SET.has(event) || !isRecord(payload)) return undefined;
  if (hasText(field(payload, 'subagentType', 'subagent_type', 'agent_id', 'agent_type'))) return undefined;

  const sessionId = bounded(field(payload, 'sessionId', 'session_id'), MAX_ID);
  if (!sessionId) return undefined;
  const result: CopilotHookEvent = { sessionId, event: event as CopilotHookEventName };

  if (event === 'sessionStart') {
    const source = bounded(field(payload, 'source'), MAX_ID);
    if (source) result.source = source;
  } else if (event === 'userPromptSubmitted') {
    const prompt = bounded(field(payload, 'prompt'), MAX_TEXT);
    if (prompt) result.prompt = prompt;
  } else if (event === 'preToolUse' || event === 'postToolUse' || event === 'permissionRequest') {
    const tool = bounded(field(payload, 'toolName', 'tool_name'), MAX_ID);
    if (tool) result.tool = tool;
  } else if (event === 'notification') {
    const notificationType = bounded(field(payload, 'notificationType', 'notification_type'), MAX_ID);
    if (notificationType) result.notificationType = notificationType;
  } else if (event === 'agentStop' || event === 'sessionEnd') {
    const reason = bounded(field(payload, 'stopReason', 'stop_reason', 'reason'), MAX_ID);
    if (reason) result.reason = reason;
  }
  return result;
}

/**
 * Write the plugin that carries the office's hooks and return its directory, for `--plugin-dir`.
 * A plugin is loaded for that one launch only, so a worker never writes into the user's
 * ~/.copilot/hooks or touches a repository's .github/hooks, and the user's login and settings stay
 * exactly where they are.
 */
export function writeCopilotPlugin(dataDir: string): { dir: string; hook: string } {
  const dir = path.join(dataDir, 'copilot-plugin');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const hook = path.join(dir, 'agent-office-copilot-hook.cjs');
  writeFileSync(hook, COPILOT_HOOK_SOURCE, { mode: 0o600 });
  chmodSync(hook, 0o600);
  writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({
    name: 'agent-office',
    description: 'Reports this worker’s status to the office',
    version: '1.0.0',
  }, null, 2), { mode: 0o600 });
  // `exec` + `args` runs the office's own node without a shell, so nothing needs quoting (Windows too).
  const hooks: Record<string, unknown[]> = {};
  for (const event of COPILOT_HOOK_EVENTS) hooks[event] = [{ type: 'command', exec: process.execPath, args: [hook, event], timeoutSec: 3 }];
  writeFileSync(path.join(dir, 'hooks.json'), JSON.stringify({ version: 1, hooks }, null, 2), { mode: 0o600 });
  return { dir, hook };
}

/** Drop launch flags the office always sets itself, plus model/effort/session flags it may replace. */
export function withoutCopilotLaunchArgs(args: string[]): string[] {
  const skipValue = new Set([
    '--model', '--reasoning-effort', '--session-id', '--resume', '-r', '--connect', '--plugin-dir',
    '--additional-mcp-config', '-i', '--interactive', '-p', '--prompt',
  ]);
  const skipFlag = new Set(['--continue', '--acp']);
  const clean: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (skipFlag.has(arg)) continue;
    if (skipValue.has(arg)) {
      if (args[i + 1] !== undefined && !args[i + 1].startsWith('-')) i++;
      continue;
    }
    if (arg.startsWith('--model=') || arg.startsWith('--reasoning-effort=') || arg.startsWith('--session-id=')
      || arg.startsWith('--resume=') || arg.startsWith('--connect=') || arg.startsWith('--plugin-dir=')
      || arg.startsWith('--additional-mcp-config=') || arg.startsWith('--interactive=') || arg.startsWith('--prompt=')) continue;
    clean.push(arg);
  }
  return clean;
}

/** The helper only reads bounded hook stdin and the worker bridge environment. */
export const COPILOT_HOOK_SOURCE = String.raw`'use strict';
const MAX = 64 * 1024;
const EVENTS = new Set(${JSON.stringify(COPILOT_HOOK_EVENTS)});
const MAX_ID = 160;
const MAX_TEXT = 20000;
const allowed = (value, max) => typeof value === 'string' && value.trim() && value.trim().length <= max ? value.trim() : undefined;
const hasText = (value) => typeof value === 'string' && value.trim().length > 0;
const pick = (input, keys) => {
  for (const key of keys) if (input[key] !== undefined) return input[key];
};
const event = process.argv[2];
let size = 0;
let overflow = false;
const chunks = [];
process.stdin.on('data', (chunk) => {
  if (overflow) return;
  size += chunk.length;
  if (size > MAX) { overflow = true; return; }
  chunks.push(chunk);
});
process.stdin.on('error', () => {});
process.stdin.on('end', async () => {
  if (overflow || !EVENTS.has(event)) return;
  let input;
  try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return; }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return;
  if (hasText(pick(input, ['subagentType', 'subagent_type', 'agent_id', 'agent_type']))) return;
  const session = allowed(pick(input, ['sessionId', 'session_id']), MAX_ID);
  if (!session) return;
  const body = { sessionId: session };
  const source = event === 'sessionStart' ? allowed(pick(input, ['source']), MAX_ID) : undefined;
  const prompt = event === 'userPromptSubmitted' ? allowed(pick(input, ['prompt']), MAX_TEXT) : undefined;
  const tool = event === 'preToolUse' || event === 'postToolUse' || event === 'permissionRequest' ? allowed(pick(input, ['toolName', 'tool_name']), MAX_ID) : undefined;
  const notification = event === 'notification' ? allowed(pick(input, ['notificationType', 'notification_type']), MAX_ID) : undefined;
  const reason = event === 'agentStop' || event === 'sessionEnd' ? allowed(pick(input, ['stopReason', 'stop_reason', 'reason']), MAX_ID) : undefined;
  if (source) body.source = source;
  if (prompt) body.prompt = prompt;
  if (tool) body.toolName = tool;
  if (notification) body.notificationType = notification;
  if (reason) body.reason = reason;
  const base = process.env.AGENT_OFFICE_HOOK_URL;
  const token = process.env.AGENT_OFFICE_HOOK_TOKEN;
  const worker = process.env.AGENT_OFFICE_WORKER_ID;
  if (!base || !token || !worker) return;
  try {
    const url = new URL('/hooks/copilot', base);
    url.searchParams.set('worker', worker);
    url.searchParams.set('event', event);
    await fetch(url, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2000),
    });
  } catch {}
});
`;
