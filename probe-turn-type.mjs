import { AppServerClient } from './dist/appServerClient.js';
const c = new AppServerClient({ env: { CODEX_HOME: '/Users/gallagherpropertycompany/.codex' }, requestTimeoutMs: 30000 });
(async () => {
  await c.start();
  await c.initialize({ clientInfo: { name:'x', version:'1' }});
  const t = await c.startThread({model:'gpt-5.2-codex', modelProvider:null, cwd:'/Users/gallagherpropertycompany/Documents/gpc-codex-controller', approvalPolicy:'never', sandbox:'workspaceWrite', config:null, baseInstructions:null, developerInstructions:null});
  const turn = await c.startTurn({threadId:t.thread.id, input:[{type:'text',text:'Hi'}], cwd:'/Users/gallagherpropertycompany/Documents/gpc-codex-controller', approvalPolicy:'never', sandboxPolicy:{type:'workspaceWrite', writableRoots:['/tmp/gpc-workspaces'], networkAccess:true}, model:'gpt-5.2-codex', effort:null, summary:null});
  console.log('turn.id', turn.turn.id, typeof turn.turn.id);
  const completion = await c.waitForNotification('turn/completed', 30000, (p)=>{ console.log('candidate', p?.turn?.id, typeof p?.turn?.id); return p?.threadId===t.thread.id && p?.turn?.id === turn.turn.id; });
  console.log('completion', completion);
  await c.stop();
})();
