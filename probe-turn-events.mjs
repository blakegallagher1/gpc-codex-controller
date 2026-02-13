import { AppServerClient } from './dist/appServerClient.js';

const client = new AppServerClient({
  env: {
    CODEX_HOME: '/Users/gallagherpropertycompany/.codex',
  },
  requestTimeoutMs: 30000,
});

async function main() {
  await client.start();
  client.on('notification', (method, params) => {
    console.log('NOTIFICATION', method, JSON.stringify(params));
  });
  client.on('stderr', (line) => {
    console.error('STDERR', line.trim());
  });
  client.on('error', (err) => {
    console.error('ERROR event', err?.message || err);
  });

  const init = await client.initialize({ clientInfo: { name: 'gpc-probe', version: '0.0.1' } });
  console.log('INIT', init);

  const thread = await client.startThread({
    model: null,
    modelProvider: null,
    cwd: '/Users/gallagherpropertycompany/Documents/gpc-codex-controller',
    approvalPolicy: 'never',
    sandbox: 'workspaceWrite',
    config: null,
    baseInstructions: null,
    developerInstructions: null,
  });
  console.log('THREAD', thread);

  const turn = await client.startTurn({
    threadId: thread.thread.id,
    input: [{ type: 'text', text: 'Say hi' }],
    cwd: '/Users/gallagherpropertycompany/Documents/gpc-codex-controller',
    approvalPolicy: 'never',
    sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/tmp/gpc-workspaces'], networkAccess: true },
    model: null,
    effort: null,
    summary: null,
  });
  console.log('TURN START', turn);

  try {
    const completion = await client.waitForNotification('turn/completed', 30000, (params) => {
      return params?.threadId === thread.thread.id && params?.turn?.id === turn.turn.id;
    });
    console.log('TURN COMPLETED', completion);
  } catch (err) {
    console.error('WAIT ERROR', err?.message || err);
  } finally {
    await client.stop();
  }
}

main().catch((error) => {
  console.error('FATAL', error);
  process.exit(1);
});
