// Stands in for `claude --claude-in-chrome-mcp`: newline JSON-RPC on stdin/stdout.
import readline from 'node:readline';

const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

const tool = (name) => ({ name, description: name, inputSchema: { type: 'object', properties: {} } });

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined) return;
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-chrome', version: '1' } },
    });
  } else if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: [tool('navigate'), tool('read_page')] } });
  } else if (msg.method === 'tools/call') {
    const name = msg.params?.name;
    if (name === 'notify') send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `called ${name}` }] } });
  }
});
