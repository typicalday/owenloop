import { writeFileSync } from 'node:fs';

const promptPath = process.argv[2];
const reportedSessionId = process.argv[3];
if (promptPath === undefined || reportedSessionId === undefined) process.exit(2);

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  prompt += chunk;
});
process.stdin.on('end', () => {
  writeFileSync(promptPath, prompt);
  process.stdout.write(`${JSON.stringify({
    type: 'system',
    subtype: 'init',
    session_id: reportedSessionId,
    claude_code_version: 'local-test',
    model: 'local-test',
    apiKeySource: 'none',
    permissionMode: 'default',
    cwd: process.cwd(),
    mcp_servers: [],
  })}\n`);
  process.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success' })}\n`);
});
