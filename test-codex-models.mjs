import { AppServerClient } from './dist/appServerClient.js';

const models = ['gpt-5.3-codex-spark','gpt-5.2-codex','gpt-4.1','gpt-4.1-mini','gpt-5','gpt-4o','gpt-4o-mini','gpt-4.5','gpt-4'];

const client = new AppServerClient({ env: { CODEX_HOME: '/Users/gallagherpropertycompany/.codex' }, requestTimeoutMs: 30000 });

async function testModel(model) {
  try {
    const startResult = await client.startThread({
      model,
      modelProvider: null,
      cwd: '/Users/gallagherpropertycompany/Documents/gpc-codex-controller',
      approvalPolicy: 'never',
      sandbox: 'workspaceWrite',
      config: null,
      baseInstructions: null,
      developerInstructions: null,
    });

    const turn = await client.startTurn({
      threadId: startResult.thread.id,
      input: [{ type: 'text', text: 'Reply with OK' }],
      cwd: '/Users/gallagherpropertycompany/Documents/gpc-codex-controller',
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/tmp/gpc-workspaces'], networkAccess: true },
      model,
      effort: null,
      summary: null,
    });

    const completion = await client.waitForNotification('turn/completed', 30000, (p) => {
      return p?.turn?.id === turn.turn.id;
    });
    console.log(model, '->', completion?.turn?.status, completion?.turn?.error?.message ?? 'ok');
  } catch (error) {
    console.log(model, 'ERROR', error.message);
  }
}

(async () => {
  await client.start();
  await client.initialize({ clientInfo: { name:'m', version:'1' }});
  for (const m of models) {
    await testModel(m);
  }
  await client.stop();
})();
