/**
 * A tiny stream-json stand-in for the pinned CLI protocol. It deliberately does
 * not emulate a model: its only job is to prove the SDK initializes registered
 * hooks, routes PreToolUse callback requests, and returns their decisions before
 * this fixture considers an inside marker readable.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const capturePath = process.env.PRETOOL_CAPTURE;
const mode = process.env.PRETOOL_FIXTURE_MODE ?? 'normal';
const outsideMarker = process.env.PRETOOL_OUTSIDE_MARKER;
const expectedSession = '99999999-9999-4999-8999-999999999999';
let hookId;
const pending = [
  ['Read', { file_path: 'inside-marker.txt' }, 'inside-read'],
  ['Read', { file_path: outsideMarker ?? '../outside-marker.txt' }, 'outside-read'],
  ['Glob', { path: 'inside' }, 'inside-glob'],
  ['Glob', { path: '../outside' }, 'outside-glob'],
  ['Grep', { path: 'inside' }, 'inside-grep'],
  ['Grep', { path: '../outside' }, 'outside-grep'],
];
const requestedTools = new Map();

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function record(value) {
  if (capturePath !== undefined) appendFileSync(capturePath, `${JSON.stringify(value)}\n`);
}

function next() {
  const item = pending.shift();
  if (item === undefined) {
    send({ type: 'result', subtype: 'success' });
    return;
  }
  const [toolName, toolInput, name] = item;
	requestedTools.set(name, { toolName, toolInput });
  send({
    type: 'control_request',
    request_id: `hook-request-${name}`,
    request: {
      subtype: 'hook_callback',
      callback_id: hookId,
      tool_use_id: `toolu-${name}`,
      input: {
	hook_event_name: 'PreToolUse',
	tool_name: toolName,
	tool_input: toolInput,
	tool_use_id: `toolu-${name}`,
      },
    },
  });
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.type === 'control_request' && message.request?.subtype === 'initialize') {
    hookId = message.request.hooks?.PreToolUse?.[0]?.hookCallbackIds?.[0];
    record({ kind: 'initialize', mode, hooks: message.request.hooks, argv: process.argv.slice(2) });
    send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id } });
    send({
      type: 'system', subtype: 'init', session_id: expectedSession,
      claude_code_version: 'fixture', model: mode === 'substituted' ? 'substituted-model' : 'gpt-5.6-luna', apiKeySource: 'oauth', permissionMode: 'default', cwd: process.cwd(),
      mcp_servers: [], tools: ['Read', 'Glob', 'Grep'], slash_commands: [], output_style: 'default', skills: [], plugins: [],
    });
	if (mode === 'substituted') return;
	if (mode === 'fallback') {
	  send({ type: 'system', subtype: 'model_refusal_fallback' });
	  return;
	}
    next();
    return;
  }
  if (message.type === 'control_response' && message.response?.request_id?.startsWith('hook-request-')) {
    const decision = message.response.response?.hookSpecificOutput?.permissionDecision;
    const name = message.response.request_id.slice('hook-request-'.length);
    record({ kind: 'hook', name, decision });
	const request = requestedTools.get(name);
	if (request?.toolName === 'Read') {
	  if (decision === 'allow') {
		const content = readFileSync(request.toolInput.file_path, 'utf8');
		record({ kind: 'read', name, content });
	  } else {
		record({ kind: 'read-skipped', name, decision });
	  }
	}
    next();
  }
});
