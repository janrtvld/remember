import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import type { ElectronApplication, Page } from 'playwright-core'

const title = 'Confirm ambient lifecycle'
const text = 'Sent by Jan: I will confirm the ambient lifecycle result tomorrow. QA ambient commitment.'

function replaceOnce(file: string, pattern: RegExp, replacement: string) {
  const source = readFileSync(file, 'utf8')
  assert.equal([...source.matchAll(new RegExp(pattern, 'g'))].length, 1, `One fixture boundary in ${file}`)
  writeFileSync(file, source.replace(pattern, replacement))
}

/** Install only in the runner's disposable source snapshot, before its build. */
export function installAmbientTasksFixture(directory: string) {
  const input = join(directory, 'ambient-native-input.json')
  writeFileSync(input, JSON.stringify({ text: 'Synthetic ambient capture is ready.' }))
  const context = join(directory, 'ambient-context-fixture.cjs')
  writeFileSync(
    context,
    `#!${process.execPath}
const fs = require('node:fs');
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
if (process.argv.includes('--permission-status') || process.argv.includes('--request-permissions')) {
 send({type:'permissions',accessibility:true,input_monitoring:true});
} else {
 const emit = () => send({type:'context',timestamp:Date.now(),app_name:'Ambient QA',bundle_id:'test.remember.ambient-qa',window_title:'Synthetic sent commitment',text:JSON.parse(fs.readFileSync(${JSON.stringify(input)},'utf8')).text,text_source:'accessibility',trigger:'content-change',monitor_name:'QA',screenshot_path:'',url:'https://ambient-qa.invalid/sent'});
 emit(); const timer=setInterval(emit,1000);
 process.on('SIGINT',()=>{clearInterval(timer);process.exit(0)});
}
`,
    { mode: 0o700 }
  )
  replaceOnce(
    join(directory, 'src/main/dailyReview/context.ts'),
    /function helperPath\(\) \{[\s\S]*?\n\}/,
    `function helperPath() { return ${JSON.stringify(context)} }`
  )

  const executable = join(directory, 'ambient-codex-fixture.cjs')
  writeFileSync(
    executable,
    `#!${process.execPath}
const fs=require('node:fs');
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
if(process.argv.includes('--version')) { console.log('codex-cli 0.0.0-ambient-qa'); process.exit(0) }
if(process.argv.includes('login') && process.argv.includes('status')) { console.log('Logged in using ChatGPT'); process.exit(0) }
if(!process.argv.includes('exec')) process.exit(2);
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);
process.stdin.on('end',()=>{
 const payload=JSON.parse(input.slice(input.lastIndexOf('\\n\\n')+2));
 if(!Array.isArray(payload.evidence)) throw new Error('Only ambient analysis is expected');
 const schemaAt=process.argv.indexOf('--output-schema');
 if(schemaAt<0 || !JSON.parse(fs.readFileSync(process.argv[schemaAt+1],'utf8')).required.includes('consideredEvidenceIds')) throw new Error('Missing production structured schema');
 const evidence=payload.evidence.find(entry=>entry.text.includes('QA ambient commitment.'));
 const answer={consideredEvidenceIds:payload.evidence.map(entry=>entry.evidenceId),proposed:evidence?[{id:null,titleChangeReason:null,title:${JSON.stringify(title)},description:'Confirm the ambient lifecycle result tomorrow.',prompt:'',aiSuggestion:null,context:evidence.text,returnPoint:{lastMove:'Commitment sent.',unresolved:'Confirmation pending.',nextMove:'Confirm the result.'},source:{kind:'task',evidenceId:evidence.evidenceId,label:'Synthetic sent commitment',detail:'Explicit synthetic user commitment.',conversationStartTime:null},evidenceQuote:evidence.text,ownership:'user',notify:true}]:[],changes:[]};
 send({type:'thread.started',thread_id:'qa-ambient-readonly'});
 send({type:'item.completed',item:{id:'answer',type:'agent_message',text:JSON.stringify(answer)}});
 send({type:'turn.completed',usage:{input_tokens:1,cached_input_tokens:0,output_tokens:1}});
});
`,
    { mode: 0o700 }
  )
  replaceOnce(
    join(directory, 'src/main/codexRuntime.ts'),
    /export function bundledCodexExecutable\(\) \{[\s\S]*?\n\}/,
    `export function bundledCodexExecutable() { return ${JSON.stringify(executable)} }`
  )
  const main = join(directory, 'src/main/dailyReview/index.ts')
  writeFileSync(
    main,
    `${readFileSync(main, 'utf8')}
const qaAmbientNotifications: Notification[] = []
Notification.isSupported = () => true
Notification.prototype.show = function () { qaAmbientNotifications.push(this) }
Object.assign(globalThis, { qaAmbient: {
  notifications: () => qaAmbientNotifications.map(entry => ({ title: entry.title, body: entry.body })),
  click: (title: string) => {
    const entry = qaAmbientNotifications.find(candidate => candidate.title === title)
    if (!entry) throw new Error('qa-ambient-notification-missing')
    entry.emit('click')
  },
} })
`
  )
}

async function waitFor(check: () => Promise<boolean>, label: string, milliseconds = 55_000) {
  const deadline = Date.now() + milliseconds
  while (!(await check())) {
    assert(Date.now() < deadline, label)
    await delay(100)
  }
}

function inspect(directory: string) {
  const database = new DatabaseSync(join(directory, 'profile/daily-review/evidence.sqlite'), { readOnly: true })
  const chat = new DatabaseSync(join(directory, 'profile/daily-review/assistant/conversation.sqlite'), {
    readOnly: true,
  })
  try {
    return {
      tasks: database
        .prepare('SELECT id, title FROM work_item WHERE title = ?')
        .all(title)
        .map((row) => ({ ...row })),
      sources: database
        .prepare(
          'SELECT s.*, c.text FROM ambient_task_source s JOIN context_evidence c ON c.id = s.source_id WHERE c.text LIKE ?'
        )
        .all(`${text}%`)
        .map((row) => ({ ...row })),
      cursor: database
        .prepare(
          'SELECT a.* FROM ambient_task_evidence a JOIN context_evidence c ON c.id = a.source_id WHERE c.text LIKE ?'
        )
        .all(`${text}%`)
        .map((row) => ({ ...row })),
      notifications: database
        .prepare(
          'SELECT n.* FROM ambient_task_notification n JOIN work_item w ON w.id = n.work_item_id WHERE w.title = ?'
        )
        .all(title)
        .map((row) => ({ ...row })),
      suggestions: chat
        .prepare(
          'SELECT s.*, m.role, m.text, m.status FROM assistant_task_suggestion s JOIN assistant_message m ON m.id = s.message_id'
        )
        .all()
        .map((row) => ({ ...row })),
    }
  } finally {
    database.close()
    chat.close()
  }
}

export async function ambientTasksQa(
  electron: ElectronApplication,
  page: Page,
  directory: string,
  desktopDirectory: string
) {
  const initialChat = await page.evaluate(() => window.remember.getAssistantConversation())
  assert.deepEqual(initialChat.messages, [])
  assert.equal(initialChat.activeTurnId, null)
  await page.evaluate(() =>
    window.remember.updateSettings({
      offlineMode: false,
      cloudAnalysisConsent: true,
      liveTaskUpdates: true,
      frequentDayRefresh: false,
      audioCaptureEnabled: false,
      capturePaused: false,
      captureSchedule: { enabled: false, weekdays: [1, 2, 3, 4, 5], startTime: '09:00', endTime: '17:00' },
    })
  )
  await page.evaluate(() => window.remember.resumeCapture())
  await waitFor(
    () => page.evaluate(async () => (await window.remember.getState()).status === 'recording'),
    'Production capture startup must become active'
  )
  const injectedAt = Date.now()
  writeFileSync(join(desktopDirectory, 'ambient-native-input.json'), JSON.stringify({ text }))
  await waitFor(
    () =>
      page.evaluate(
        async (title) => (await window.remember.listWorkItems()).some((item) => item.title === title),
        title
      ),
    'Native context must create an ambient task without Day refresh'
  )
  const createdAt = Date.now()
  await waitFor(
    () =>
      electron.evaluate(
        (_electron, title) =>
          Reflect.get(globalThis, 'qaAmbient')
            .notifications()
            .some((entry: { title: string }) => entry.title === title),
        title
      ),
    'Committed task must produce a native notification'
  )
  await electron.evaluate((_electron, title) => Reflect.get(globalThis, 'qaAmbient').click(title), title)
  await page.waitForURL((url) => url.pathname === '/inbox/' && Boolean(url.searchParams.get('item')))
  await waitFor(async () => {
    const chat = await page.evaluate(() => window.remember.getAssistantConversation())
    return chat.messages.length === 1 && chat.messages[0]?.text.includes(title) === true
  }, 'The same source-backed task must appear as one persistent assistant offer')
  const state = inspect(directory)
  assert.equal(state.tasks.length, 1)
  assert(state.sources.length >= 1)
  assert(state.cursor.every((row) => typeof row.completed_at === 'number'))
  assert.equal(state.notifications.length, 1)
  assert.equal(typeof state.notifications[0]?.delivered_at, 'number')
  assert.equal(typeof state.notifications[0]?.chat_recorded_at, 'number')
  assert.equal(state.suggestions.length, 1)
  const suggestion = state.suggestions[0]
  assert(suggestion)
  assert.equal(suggestion.task_id, state.tasks[0]?.id)
  assert.equal(suggestion.event_id, `ambient-task:${suggestion.task_id}`)
  assert.equal(suggestion.role, 'assistant')
  assert.equal(suggestion.status, 'completed')
  assert.deepEqual(JSON.parse(String(suggestion.evidence_ids)), [
    ...new Set(state.sources.map((source) => source.source_id)),
  ])
  const chat = await page.evaluate(() => window.remember.getAssistantConversation())
  assert.equal(chat.activeTurnId, null, 'An observed offer must not start tool work')
  assert.equal(chat.messages.filter((message) => message.role === 'user').length, 0)
  assert.equal(new URL(page.url()).searchParams.get('item'), state.tasks[0]?.id)
  await page.screenshot({ path: join(directory, 'ambient-task-notification-open.png') })
  await page.goto(new URL('/assistant/', page.url()).toString())
  const taskLink = page.locator(`a[href="/inbox/?item=${state.tasks[0]?.id}"]`)
  await taskLink.waitFor()
  await page.screenshot({ path: join(directory, 'ambient-task-assistant-offer.png') })
  await taskLink.click()
  await page.waitForURL((url) => url.pathname === '/inbox/' && url.searchParams.get('item') === state.tasks[0]?.id)
  writeFileSync(
    join(directory, 'ambient-before-restart.json'),
    JSON.stringify({ ...state, desktopDirectory, injectedAt, createdAt, elapsedMs: createdAt - injectedAt }, null, 2)
  )
}

export async function ambientTasksAfterRestartQa(electron: ElectronApplication, page: Page, directory: string) {
  await waitFor(
    () => page.evaluate(async () => (await window.remember.getState()).status === 'recording'),
    'Capture must resume after full restart'
  )
  const before = JSON.parse(readFileSync(join(directory, 'ambient-before-restart.json'), 'utf8'))
  writeFileSync(
    join(before.desktopDirectory, 'ambient-native-input.json'),
    JSON.stringify({ text: `${text} Read again after restart.` })
  )
  await waitFor(async () => {
    const state = inspect(directory)
    return (
      state.cursor.length > before.cursor.length && state.cursor.every((row) => typeof row.completed_at === 'number')
    )
  }, 'New native frame must be analyzed and acknowledged after the real batch delay')
  const after = inspect(directory)
  assert.deepEqual(after.tasks, before.tasks)
  assert(after.cursor.length > before.cursor.length, 'Restart must ingest a genuinely new native context frame')
  assert(after.cursor.every((row) => typeof row.completed_at === 'number'))
  assert.deepEqual(after.notifications, before.notifications)
  assert.deepEqual(after.suggestions, before.suggestions)
  const chat = await page.evaluate(() => window.remember.getAssistantConversation())
  assert.equal(chat.messages.length, 1)
  assert.equal(chat.messages[0]?.role, 'assistant')
  assert.equal(chat.activeTurnId, null)
  assert.equal(
    await electron.evaluate(
      (_electron, title) =>
        Reflect.get(globalThis, 'qaAmbient')
          .notifications()
          .filter((entry: { title: string }) => entry.title === title).length,
      title
    ),
    0
  )
  writeFileSync(
    join(directory, 'ambient-proof.json'),
    JSON.stringify(
      {
        startupThroughNativeContextParser: true,
        liveTaskWithoutDayRefresh: true,
        exactPersistedSources: after.sources,
        acknowledgedSources: after.cursor.length,
        notificationOpenedTask: true,
        fullRestart: true,
        repeatedCommitmentDeduplicated: true,
        notificationNotReplayed: true,
        persistentAssistantOffers: after.suggestions,
        assistantTaskLinkOpenedSameTask: true,
        assistantOfferNotReplayed: true,
        noAutomaticUserMessageOrToolTurn: true,
        observedContextToTaskMs: before.elapsedMs,
        boundary:
          'Synthetic native context executable and deterministic Codex exec JSON through production parser, SDK, worker, SQLite, notification click, preload and renderer; no physical screen/audio capture or live model judgment.',
      },
      null,
      2
    )
  )
  await page.evaluate(() =>
    window.remember.updateSettings({ liveTaskUpdates: false, capturePaused: true, offlineMode: true })
  )
}
