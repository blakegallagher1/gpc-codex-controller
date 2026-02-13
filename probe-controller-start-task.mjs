import { Controller } from './dist/controller.js';
import { AppServerClient } from './dist/appServerClient.js';

const controller = new Controller(new AppServerClient({ env: { CODEX_HOME: '/Users/gallagherpropertycompany/.codex' }, requestTimeoutMs: 30000 }), {
  workspacePath: '/Users/gallagherpropertycompany/Documents/gpc-codex-controller',
  stateFilePath: '/tmp/gpc-direct-controller-state.json',
  streamToStdout: true,
});

console.log('starting');
try {
  const result = await controller.startTask('Reply with exactly: ok');
  console.log('RESULT', result);
} catch (error) {
  console.error('ERR', error);
  process.exit(1);
}
