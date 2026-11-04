import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import type { ElectronApplication, Page } from 'playwright-core'

const sourceText =
  'Atlas build failed: src/routes/checkout.ts:42 TS2339: Property total does not exist on type Cart. The editor is open at the failing line; no assignment or commitment is shown.'
const initiativeText =
  'The Atlas build stops at checkout.ts:42 because Cart has no total property. Want me to help inspect that error?'
const explicitText = 'qa-proactive-explicit: reply with the synthetic confirmation only.'
const explicitAnswer = 'Synthetic explicit reply verified.'
const dayTaskTitle = 'Write an application introduction using Atlas project experience'
const dayFact =
  'In project Atlas, Jan built a TypeScript scheduling interface and reduced manual planning steps from six to two.'
const daySummary = `Jan is preparing an engineering application. ${dayFact} The application introduction is still unwritten.`
const liveReviewSummary =
  'Jan is preparing an engineering application. The application introduction is still unwritten.'
const dayInitiative =
  'Draft opening: “In Atlas, I built a TypeScript scheduling interface that reduced manual planning from six steps to two. I would bring that same focus on practical improvements to this engineering role.”'
const dayQuestion = 'Shorten that draft to one sentence, using only what you already said.'
const dayAnswer =
  'In Atlas, I built a TypeScript scheduling interface that reduced manual planning from six steps to two.'

const invitationContext =
  'Jan denkt aan een filmavond thuis met zes buren. Hij wil popcorn en weinig gedoe. Er is nog geen datum gekozen. Hij weet nog niet goed hoe hij hen zal uitnodigen.'
const filmContext =
  'Voor de filmavond thuis met zes buren zoekt Jan een luchtige film. Hij wil geen horror en heeft nog geen film gekozen.'
const invitationOffer = 'Leuk, zo’n filmavond met de buren. Zal ik een kort uitnodigingsberichtje voor je maken?'
const filmOffer = 'Voor zo’n ontspannen avond past iets luchtigs. Zal ik drie films zonder horror voor je uitzoeken?'
const invitationDraft =
  'Hé buren! Zin in een filmavond bij mij thuis? Ik zorg voor popcorn en verder houden we het lekker simpel. Er staat nog geen datum vast — wanneer zouden jullie kunnen?'
const acceptOffer = 'ja graag'
const declineOffer = 'nu even niet'

function replaceOnce(file: string, pattern: RegExp, replacement: string) {
  const source = readFileSync(file, 'utf8')
  assert.equal([...source.matchAll(new RegExp(pattern, 'g'))].length, 1, `One fixture boundary in ${file}`)
  writeFileSync(file, source.replace(pattern, replacement))
}

/** These replacements are confined to the runner's disposable source snapshot. */
export function installProactiveAgentFixture(
  directory: string,
  options: { skipCodexFixture?: boolean; daySync?: boolean; dayReview?: boolean } = {}
) {
  assert(!directory.endsWith('/apps/desktop'), 'Never install a QA executable in the checkout')
  const input = join(directory, 'proactive-native-input.json')
  const captureLog = join(directory, 'proactive-context.jsonl')
  writeFileSync(input, JSON.stringify({ text: '' }))
  writeFileSync(captureLog, '')
  const context = join(directory, 'proactive-context-fixture.cjs')
  writeFileSync(
    context,
    `#!${process.execPath}
const fs = require('node:fs');
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
if (process.argv.includes('--permission-status') || process.argv.includes('--request-permissions')) {
 send({type:'permissions',accessibility:true,input_monitoring:true});
} else {
 const emit = () => {
  const input = JSON.parse(fs.readFileSync(${JSON.stringify(input)},'utf8'));
  if (!input.text && !input.emitEmpty) return;
  const event = {type:'context',timestamp:Date.now(),app_name:'Test Editor',bundle_id:'com.example.proactive-fixture',window_title:'Atlas build',text:input.text,text_source:'accessibility',trigger:'content-change',monitor_name:'Synthetic display',screenshot_path:'',url:'https://proactive-qa.invalid/atlas'};
  fs.appendFileSync(${JSON.stringify(captureLog)},JSON.stringify({pid:process.pid,event})+'\\n');
  send(event);
 };
 emit(); const timer=setInterval(emit,1000);
 for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>{clearInterval(timer);process.exit(0)});
}
`,
    { mode: 0o700 }
  )
  replaceOnce(
    join(directory, 'src/main/dailyReview/context.ts'),
    /function helperPath\(\) \{[\s\S]*?\n\}/,
    `function helperPath() { return ${JSON.stringify(context)} }`
  )
  const inferenceLog = join(directory, 'proactive-inference.jsonl')
  writeFileSync(inferenceLog, '')
  const analyzer = join(directory, 'src/main/dailyReview/analyzer.ts')
  replaceOnce(
    analyzer,
    /import \{ mkdtempSync, rmSync \} from 'node:fs'/,
    "import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'"
  )
  replaceOnce(
    analyzer,
    / {4}const turn = await thread\.run\(`\$\{options\.systemPrompt\}\\n\\n\$\{options\.prompt\}`, configuration\.turn\)/,
    `    appendFileSync(${JSON.stringify(inferenceLog)}, JSON.stringify({ kind: 'start', at: Date.now(), model, effort, toolsDisabled: options.toolsDisabled, prompt: options.prompt, systemPrompt: options.systemPrompt }) + '\\n')
    const turn = await thread.run(\`$\{options.systemPrompt}\\n\\n$\{options.prompt}\`, configuration.turn)
    appendFileSync(${JSON.stringify(inferenceLog)}, JSON.stringify({ kind: 'completed', at: Date.now(), model, effort, usage: turn.usage, output: turn.finalResponse }) + '\\n')`
  )
  if (options.daySync) {
    const dayInput = join(directory, 'proactive-day-input.json')
    const dayLog = join(directory, 'proactive-day-refresh.jsonl')
    writeFileSync(
      dayInput,
      JSON.stringify({
        summary: options.dayReview ? (options.skipCodexFixture ? liveReviewSummary : daySummary) : invitationContext,
        sourceId: 'qa-day-application-context',
        sourceText: options.dayReview ? dayFact : invitationContext,
      })
    )
    writeFileSync(dayLog, '')
    writeFileSync(
      join(directory, 'src/main/dailyReview/proactiveDayQa.ts'),
      `import { appendFileSync, readFileSync } from 'node:fs'
import type { generateDayMemory as ProductionDayMemory } from './analyzer'
import { prepareDayAnalysisInputs } from './dayAnalysisProvenance'
import { getEvidenceStore } from './evidenceRepository'
export const generateDayMemory: typeof ProductionDayMemory = async (day, reason, through) => {
 const input = JSON.parse(readFileSync(${JSON.stringify(dayInput)}, 'utf8'))
 const { summary } = input
 const store = getEvidenceStore()
 const sourceId = input.sourceId || 'qa-day-application-context'
 if (!(await store.readAnalysisEvidence(day.id)).some(entry => entry.evidenceId === sourceId)) {
  store.appendContextMoment(day.id, { id: sourceId, timestamp: day.startedAt + 30_000, appName: 'Synthetic conversation QA', windowTitle: 'Synthetic user context', text: input.sourceText || ${JSON.stringify(dayFact)}, textSource: 'accessibility', trigger: 'content-change', monitorName: 'Fixture display', screenshotPath: '', url: 'https://proactive-qa.invalid/context' }, null, 'com.example.proactive-fixture')
 }
 const admitted = await prepareDayAnalysisInputs({ workdayId: day.id, startedAt: day.startedAt, coveredThrough: through, previousMemory: day.memory, evidence: (await store.readAnalysisEvidence(day.id)).filter(entry => entry.evidenceId.startsWith('qa-day-')), wikiPages: [], store })
 appendFileSync(${JSON.stringify(dayLog)}, JSON.stringify({ dayId: day.id, reason, through, summary, provenance: admitted.provenance, at: Date.now() }) + '\\n')
 return { memory: { summary, analysisProvenance: admitted.provenance, currentFocus: ${JSON.stringify(options.dayReview ? 'Engineering application' : 'Filmavond met de buren')}, outcomes: [], decisions: [], openLoops: [], conversations: [], timeline: [], knowledgeSuggestions: [] }, workItems: { proposed: [], changes: [] } }
}
`
    )
    replaceOnce(
      join(directory, 'src/main/dailyReview/index.ts'),
      /import \{ generateDayMemory, generateTimelineSkill, generateTimelineWikiUpdate \} from '\.\/analyzer'/,
      "import { generateTimelineSkill, generateTimelineWikiUpdate } from './analyzer'\nimport { generateDayMemory } from './proactiveDayQa'"
    )
  }
  if (options.daySync && (!options.dayReview || options.skipCodexFixture)) {
    const clockFile = join(directory, 'proactive-review-clock.json')
    const initialClock = new Date()
    if (!options.dayReview) {
      if (initialClock.getHours() < 8) initialClock.setHours(9, 0, 0, 0)
      else if (initialClock.getHours() >= 22) {
        initialClock.setDate(initialClock.getDate() + 1)
        initialClock.setHours(9, 0, 0, 0)
      }
    }
    writeFileSync(clockFile, JSON.stringify({ offset: Math.max(0, initialClock.getTime() - Date.now()) }))
    writeFileSync(
      join(directory, 'src/main/proactiveQaClock.ts'),
      `import { readFileSync } from 'node:fs'
const NativeDate = globalThis.Date
const clockFile = ${JSON.stringify(clockFile)}
let offset = JSON.parse(readFileSync(clockFile, 'utf8')).offset
const timer = setInterval(() => { offset = JSON.parse(readFileSync(clockFile, 'utf8')).offset }, 50)
timer.unref()
const now = () => NativeDate.now() + offset
globalThis.Date = new Proxy(NativeDate, {
  construct(target, args) { return Reflect.construct(target, args.length ? args : [now()]) },
  apply() { return new NativeDate(now()).toString() },
  get(target, key) { return key === 'now' ? now : Reflect.get(target, key) },
})
`
    )
    const main = join(directory, 'src/main/index.ts')
    writeFileSync(main, `import './proactiveQaClock'\n${readFileSync(main, 'utf8')}`)
  }
  if (options.skipCodexFixture) return

  const log = join(directory, 'proactive-provider.jsonl')
  writeFileSync(log, '')
  const reviewControl = join(directory, 'proactive-review-control.json')
  if (options.dayReview) writeFileSync(reviewControl, JSON.stringify({ hold: false }))
  const executable = join(directory, 'proactive-codex-fixture.cjs')
  writeFileSync(
    executable,
    `#!${process.execPath}
const fs=require('node:fs');
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
const record=value=>fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({pid:process.pid,at:Date.now(),...value})+'\\n');
if(process.argv.includes('--version')) { console.log('codex-cli 0.0.0-proactive-qa'); process.exit(0) }
if(process.argv.includes('login') && process.argv.includes('status')) { console.log('Logged in using ChatGPT'); process.exit(0) }
if(process.argv.includes('exec')) {
 record({kind:'exec-start',argv:process.argv.slice(2)});
 let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);
 process.stdin.on('end',()=>{
  record({kind:'exec-input',input});
  const schemaAt=process.argv.indexOf('--output-schema');
  if (schemaAt < 0 && (input.includes('qa-proactive-explicit') || (${JSON.stringify(options.daySync === true)} && input.includes(${JSON.stringify(dayQuestion)})) || (${JSON.stringify(options.daySync === true && !options.dayReview)} && input.includes(${JSON.stringify(acceptOffer)})))) {
   record({kind:'explicit-chat',input});
   send({type:'thread.started',thread_id:'qa-proactive-explicit-thread'});
   send({type:'item.completed',item:{id:'explicit-answer',type:'agent_message',text:${JSON.stringify(options.daySync ? (options.dayReview ? dayAnswer : invitationDraft) : explicitAnswer)}}});
   send({type:'turn.completed',usage:{input_tokens:1,cached_input_tokens:0,output_tokens:1}});
   return;
  }
  const payload=JSON.parse(input.slice(input.lastIndexOf('\\n\\n')+2));
  if(schemaAt<0 || !JSON.parse(fs.readFileSync(process.argv[schemaAt+1],'utf8')).required.includes('initiative')) throw new Error('Missing proactive production schema');
  if(!Array.isArray(payload.evidence)||!payload.conversation) throw new Error('Only unified proactive analysis is expected');
  const daySync=${JSON.stringify(options.daySync === true)};
  const dayReview=${JSON.stringify(options.dayReview === true)};
  const evidence=payload.evidence.find(entry=>daySync ? entry.kind==='day' && entry.text.includes(${JSON.stringify(dayFact)}) : entry.text===${JSON.stringify(sourceText)});
  const tasks=daySync && evidence ? JSON.parse(evidence.text).tasks : payload.workItems;
  const openTask=tasks.some(item=>item.title===${JSON.stringify(dayTaskTitle)} && item.lifecycle==='open');
  const alreadyHelped=payload.conversation.recentMessages.some(message=>message.text===${JSON.stringify(dayInitiative)});
  const helpful=evidence && (!daySync || (openTask && (dayReview ? Boolean(JSON.parse(evidence.text).review) : !alreadyHelped)));
  const answer={consideredEvidenceIds:payload.evidence.map(entry=>entry.evidenceId),proposed:[],changes:[],initiative:helpful?{kind:daySync?'observe':'offer',text:daySync?${JSON.stringify(dayInitiative)}:${JSON.stringify(initiativeText)},topicKey:daySync?'atlas-application-introduction':'atlas-build-cart-total',sourceIds:[evidence.evidenceId],supportingQuotes:[{sourceId:evidence.evidenceId,quote:daySync?${JSON.stringify(dayFact)}:evidence.text}]}:{kind:'silent',text:'',topicKey:'',sourceIds:[],supportingQuotes:[]}};
  if(daySync&&!dayReview) {
   const current=payload.evidence.find(entry=>entry.kind==='day'&&(entry.text.includes(${JSON.stringify(filmContext)})||entry.text.includes(${JSON.stringify(invitationContext)})));
   const film=Boolean(current&&current.text.includes(${JSON.stringify(filmContext)}));
   answer.followUps=[];
   answer.initiative=current?{kind:'offer',text:film?${JSON.stringify(filmOffer)}:${JSON.stringify(invitationOffer)},topicKey:film?'filmavond-filmkeuze':'filmavond-uitnodiging',sourceIds:[current.evidenceId],supportingQuotes:[{sourceId:current.evidenceId,quote:film?${JSON.stringify(filmContext)}:${JSON.stringify(invitationContext)}}],taskIds:[]}:{kind:'silent',text:'',topicKey:'',sourceIds:[],supportingQuotes:[],taskIds:[]};
  } else if(daySync) { answer.followUps=dayReview&&openTask?[{taskId:tasks.find(item=>item.title===${JSON.stringify(dayTaskTitle)}&&item.lifecycle==='open').id,note:'Check whether the Atlas application introduction still needs a concrete draft.',nextReviewAt:Date.parse(payload.clock.utc)+3*60*60*1000}]:[]; answer.initiative.taskIds=helpful?[tasks.find(item=>item.title===${JSON.stringify(dayTaskTitle)} && item.lifecycle==='open').id]:[]; if(helpful) answer.initiative.supportingQuotes.push({sourceId:evidence.evidenceId,quote:${JSON.stringify(dayTaskTitle)}}); }
  record({kind:'analysis',argv:process.argv.slice(2),input,payload,answer});
  const complete=()=>{
  send({type:'thread.started',thread_id:'qa-proactive-analysis'});
  send({type:'item.completed',item:{id:'answer',type:'agent_message',text:JSON.stringify(answer)}});
  send({type:'turn.completed',usage:{input_tokens:1,cached_input_tokens:0,output_tokens:1}});
  };
  if(dayReview&&JSON.parse(fs.readFileSync(${JSON.stringify(reviewControl)},'utf8')).hold) {
   record({kind:'analysis-held'});
   const timer=setInterval(()=>{if(!JSON.parse(fs.readFileSync(${JSON.stringify(reviewControl)},'utf8')).hold){clearInterval(timer);complete()}},50);
   process.on('SIGTERM',()=>{record({kind:'analysis-cancelled'});process.exit(0)});
  } else complete();
 });
} else if(process.argv.includes('app-server')) {
 const thread='qa-proactive-explicit-thread',turn='qa-proactive-explicit-turn';
 require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
  const request=JSON.parse(line);record({kind:'rpc',request});
  const reply=result=>send({id:request.id,result});
  const event=(method,params)=>send({method,params:{threadId:thread,...params}});
  if(request.method==='initialize') reply({});
  else if(request.method==='thread/start'||request.method==='thread/resume') reply({thread:{id:thread}});
  else if(request.method==='turn/start') {
   if(!request.params.input.some(entry=>entry.text?.includes('qa-proactive-explicit'))) throw new Error('Unexpected explicit turn');
   reply({turn:{id:turn}});
   event('turn/started',{turn:{id:turn}});
   event('item/completed',{item:{id:'explicit-answer',type:'agentMessage',phase:'final_answer',text:${JSON.stringify(explicitAnswer)}}});
   event('turn/completed',{turn:{id:turn,status:'completed'}});
  } else if(request.method==='turn/interrupt') {reply({});event('turn/completed',{turn:{id:turn,status:'interrupted'}})}
  else if(request.id!==undefined) throw new Error('Unexpected RPC '+request.method);
 });
} else process.exit(2);
`,
    { mode: 0o700 }
  )
  replaceOnce(
    join(directory, 'src/main/codexRuntime.ts'),
    /export function bundledCodexExecutable\(\) \{[\s\S]*?\n\}/,
    `export function bundledCodexExecutable() { return ${JSON.stringify(executable)} }`
  )
  replaceOnce(
    join(directory, 'src/main/agentTurn.ts'),
    /findAgentExecutable\(input.provider\)/,
    JSON.stringify(executable)
  )
  replaceOnce(join(directory, 'src/main/codexWorker.ts'), /installedCodexWorkerTools\(options.providerHome\)/, '{}')
}

async function waitFor(check: () => Promise<boolean>, label: string, milliseconds = 60_000) {
  const deadline = Date.now() + milliseconds
  while (!(await check())) {
    assert(Date.now() < deadline, label)
    await delay(100)
  }
}

function lines(path: string): Record<string, unknown>[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function inspect(directory: string) {
  const db = new DatabaseSync(join(directory, 'profile/daily-review/evidence.sqlite'), { readOnly: true })
  const chat = new DatabaseSync(join(directory, 'profile/daily-review/assistant/conversation.sqlite'), {
    readOnly: true,
  })
  try {
    const rows = (database: DatabaseSync, sql: string) =>
      database
        .prepare(sql)
        .all()
        .map((row) => ({ ...row }))
    return {
      tasks: rows(db, 'SELECT * FROM work_item ORDER BY id'),
      events: rows(db, 'SELECT * FROM proactive_event ORDER BY sequence'),
      considered: rows(db, 'SELECT * FROM proactive_considered ORDER BY event_id'),
      decisions: rows(db, 'SELECT * FROM proactive_decision ORDER BY id'),
      consumer: rows(db, 'SELECT * FROM proactive_consumer ORDER BY name'),
      oldQueue: rows(db, 'SELECT * FROM ambient_task_evidence ORDER BY source_id'),
      context: rows(db, 'SELECT * FROM context_evidence ORDER BY id'),
      audio: rows(db, 'SELECT * FROM audio_evidence ORDER BY id'),
      messages: rows(chat, 'SELECT * FROM assistant_message ORDER BY created_at,id'),
      receipts: rows(chat, 'SELECT * FROM assistant_proactive_initiative ORDER BY decision_id'),
      dismissals: rows(chat, 'SELECT * FROM assistant_proactive_dismissal ORDER BY topic_key'),
      schedules: rows(db, 'SELECT * FROM proactive_day_schedule ORDER BY consumer'),
      reviews: rows(db, 'SELECT * FROM proactive_day_review ORDER BY checked_at,slot_id'),
      followUps: rows(db, 'SELECT * FROM proactive_follow_up ORDER BY consumer,task_id'),
      daySources: rows(db, 'SELECT * FROM proactive_day_source ORDER BY observed_at,id'),
    }
  } finally {
    db.close()
    chat.close()
  }
}

function archiveClosedDatabases(directory: string, name: string) {
  const output = join(directory, name)
  mkdirSync(output, { recursive: true })
  for (const [prefix, relative] of [
    ['evidence', 'profile/daily-review/evidence.sqlite'],
    ['assistant', 'profile/daily-review/assistant/conversation.sqlite'],
  ]) {
    for (const suffix of ['', '-wal', '-shm']) {
      const input = join(directory, `${relative}${suffix}`)
      if (existsSync(input)) copyFileSync(input, join(output, `${prefix}.sqlite${suffix}`))
    }
  }
}

function processGone(pid: number) {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true
    throw error
  }
}

function filesAt(path: string): string[] {
  if (!existsSync(path)) return []
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesAt(join(path, entry.name)) : [join(path, entry.name)]
  )
}

export async function proactiveAgentQa(options: {
  directory: string
  desktopDirectory: string
  launch: () => Promise<Page>
  close: () => Promise<void>
  getElectron: () => ElectronApplication | undefined
  checks: string[]
  live?: boolean
  daySync?: boolean
  dayReview?: boolean
}) {
  if (options.daySync) return proactiveDaySyncQa(options)
  const { directory, desktopDirectory, launch, close, getElectron, checks, live = false } = options
  const write = (name: string, value: unknown) => writeFileSync(join(directory, name), JSON.stringify(value, null, 2))
  let page = await launch()
  const initial = inspect(directory)
  const initialFiles = filesAt(join(directory, 'profile/daily-review')).filter((file) =>
    /\.(png|jpe?g|webp|wav|m4a|mp3|aiff)$/i.test(file)
  )
  assert.equal(initial.messages.length, 0)
  write('proactive-initial.json', initial)
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
    async () =>
      (await page.evaluate(() => window.remember.getState())).status === 'recording' &&
      inspect(directory).consumer.some((row) => row.enabled === 1),
    'Synthetic context capture and proactive consumer must start'
  )
  const injectedAt = Date.now()
  writeFileSync(join(desktopDirectory, 'proactive-native-input.json'), JSON.stringify({ text: sourceText }))
  await waitFor(
    async () =>
      (await page.evaluate(() => window.remember.getAssistantConversation())).messages.some((message) =>
        Boolean(message.initiative)
      ),
    'One source-backed initiative must appear without Send or a Task',
    live ? 65_000 : 45_000
  )
  const conversation = await page.evaluate(() => window.remember.getAssistantConversation())
  assert.equal(conversation.messages.length, 1)
  const message = conversation.messages[0]
  assert(message?.initiative)
  assert.equal(message.role, 'assistant')
  assert.equal(message.replyTo, null)
  if (!live) assert.equal(message.text, initiativeText)
  assert(message.initiative.sources.length > 0)
  assert(
    message.initiative.sources.every((source) => sourceText.includes(source.quote) && source.appName === 'Test Editor')
  )
  const delivered = inspect(directory)
  assert.deepEqual(delivered.tasks, initial.tasks, 'Observation must not be manufactured into a Task')
  assert.equal(delivered.receipts.length, 1)
  const receipt = delivered.receipts[0]
  assert(receipt)
  assert.equal(receipt.message_id, message.id)
  const decision = delivered.decisions.find((row) => row.id === receipt.decision_id)
  assert(decision)
  assert.equal(decision.delivered_message_id, message.id)
  assert.equal(decision.input_hash, receipt.input_hash)
  const storedDecision = JSON.parse(String(decision.decision_json))
  const deliveredDecision = JSON.parse(String(receipt.payload_json))
  assert.deepEqual(deliveredDecision, { ...storedDecision, inputHash: decision.input_hash })
  for (const reference of storedDecision.sourceRefs as Array<Record<string, unknown>>) {
    const event = delivered.events.find((row) => row.event_id === reference.eventId)
    const context = delivered.context.find((row) => row.id === reference.sourceId)
    assert(event && context)
    assert.equal(event.event_revision, reference.eventRevision)
    assert.equal(event.content_key, reference.contentKey)
    assert.equal(event.source_id, context.id)
    assert.equal(reference.observedAt, context.timestamp)
    assert.equal(context.text, sourceText)
  }
  assert(
    delivered.oldQueue.every((row) => row.completed_at === null),
    'New consumer must not ACK the legacy queue'
  )
  assert.equal(conversation.activeTurnId, null)
  write('proactive-delivered.json', { state: delivered, conversation, injectedAt, receivedAt: Date.now() })
  checks.push('Synthetic AX source reaches the unified interpreter and durable chat without Send or Task creation')

  const root = page.locator(`[data-proactive-decision="${message.initiative.decisionId}"]`)
  await root.waitFor()
  await page.screenshot({ path: join(directory, 'proactive-standard.png') })
  await page.setViewportSize({ width: 720, height: 900 })
  const menuButton = root.getByRole('button', { name: /^(Opties voor bericht|Message options)$/ })
  await menuButton.focus()
  await page.keyboard.press('Enter')
  await page.getByRole('menuitem', { name: /^(Bronnen bekijken|View sources)$/ }).click()
  const sources = page.getByRole('dialog', { name: /^(Bronnen|Sources)$/ })
  await sources.getByRole('heading', { name: /^(Bronnen|Sources)$/ }).waitFor()
  assert.equal(await sources.locator('blockquote').first().textContent(), message.initiative.sources[0]?.quote)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true)
  await page.screenshot({ path: join(directory, 'proactive-sources-720.png') })
  await sources.getByRole('button', { name: /^(Sluiten|Close)$/ }).click()
  await sources.getByRole('heading', { name: /^(Bronnen|Sources)$/ }).waitFor({ state: 'hidden' })
  await menuButton.focus()
  await page.keyboard.press('Enter')
  const dismiss = page.getByRole('menuitem', { name: /^(Nu even niet|Not now)$/ })
  await dismiss.focus()
  await page.keyboard.press('Enter')
  await waitFor(
    async () =>
      (await page.evaluate(() => window.remember.getAssistantConversation())).messages.find(
        (candidate) => candidate.id === message.id
      )?.initiative?.dismissed === true,
    'Keyboard dismissal must persist on this exact initiative'
  )
  await page.screenshot({ path: join(directory, 'proactive-dismissed-720.png') })
  if (!live) {
    const composer = page.locator('#assistant-message')
    await composer.fill(explicitText)
    await page.getByRole('button', { name: /^(Versturen|Send)$/ }).click()
    await waitFor(
      async () =>
        (await page.evaluate(() => window.remember.getAssistantConversation())).messages.some(
          (candidate) => candidate.text === explicitAnswer && candidate.status === 'completed'
        ),
      'Ordinary explicit chat must still complete through the deterministic provider'
    )
  }
  checks.push(
    live
      ? 'At 720px the source quote opens by keyboard and exact dismissal persists; ordinary chat is omitted to bound live inference'
      : 'At 720px the source quote opens by keyboard and exact dismissal persists; explicit fixture chat remains usable'
  )

  const repeatedAfter = Date.now()
  await waitFor(
    async () =>
      lines(join(desktopDirectory, 'proactive-context.jsonl')).filter(
        (row) => Number((row.event as Record<string, unknown>).timestamp) >= repeatedAfter
      ).length >= 4,
    'The synthetic helper must actually repeat the same source'
  )
  const beforeRestart = inspect(directory)
  assert.deepEqual(beforeRestart.tasks, initial.tasks)
  assert.equal(beforeRestart.receipts.length, 1)
  assert.deepEqual(beforeRestart.audio, initial.audio)
  write('proactive-before-restart.json', beforeRestart)
  const firstPid = getElectron()?.process().pid
  assert(firstPid)
  writeFileSync(join(desktopDirectory, 'proactive-native-input.json'), JSON.stringify({ text: '', emitEmpty: true }))
  await close()
  await waitFor(async () => processGone(firstPid), 'The first native process must exit completely')
  archiveClosedDatabases(directory, 'proactive-closed-databases')

  const restartedAt = Date.now()
  page = await launch()
  await waitFor(
    async () => (await page.evaluate(() => window.remember.getState())).status === 'recording',
    'Synthetic context capture resumes after full restart'
  )
  await waitFor(
    async () => inspect(directory).context.some((row) => row.text === '' && Number(row.timestamp) >= restartedAt),
    'A real blank synthetic AX frame must clear the previous visible lines before they reappear'
  )
  writeFileSync(join(desktopDirectory, 'proactive-native-input.json'), JSON.stringify({ text: sourceText }))
  await waitFor(
    async () => inspect(directory).events.length > beforeRestart.events.length,
    'Restart must commit a fresh event for the identical synthetic source'
  )
  await waitFor(
    async () => inspect(directory).considered.length > beforeRestart.considered.length,
    'The new consumer must durably consider the repeated source'
  )
  const afterRestart = inspect(directory)
  assert.deepEqual(afterRestart.messages, beforeRestart.messages)
  assert.deepEqual(afterRestart.receipts, beforeRestart.receipts)
  assert.deepEqual(afterRestart.dismissals, beforeRestart.dismissals)
  assert.deepEqual(afterRestart.tasks, initial.tasks)
  assert.deepEqual(afterRestart.audio, initial.audio)
  assert(afterRestart.oldQueue.every((row) => row.completed_at === null))
  const reopened = await page.evaluate(() => window.remember.getAssistantConversation())
  assert.equal(reopened.messages.find((candidate) => candidate.id === message.id)?.initiative?.dismissed, true)
  assert.equal(reopened.activeTurnId, null)
  const capture = await page.evaluate(() => window.remember.getState())
  const settings = await page.evaluate(() => window.remember.getSettings())
  assert.equal(settings.audioCaptureEnabled, false)
  const finalFiles = filesAt(join(directory, 'profile/daily-review')).filter((file) =>
    /\.(png|jpe?g|webp|wav|m4a|mp3|aiff)$/i.test(file)
  )
  assert.deepEqual(finalFiles, initialFiles, 'No new screen or audio files may be captured')
  const sourceEvents = lines(join(desktopDirectory, 'proactive-context.jsonl'))
  assert(
    sourceEvents.every(
      (row) =>
        (row.event as Record<string, unknown>).screenshot_path === '' &&
        (row.event as Record<string, unknown>).bundle_id === 'com.example.proactive-fixture'
    )
  )
  const calls = live ? null : lines(join(desktopDirectory, 'proactive-provider.jsonl'))
  const inference = lines(join(desktopDirectory, 'proactive-inference.jsonl'))
  assert.equal(inference.filter((call) => call.kind === 'start').length, 1)
  assert.equal(inference.filter((call) => call.kind === 'completed').length, 1)
  assert(inference.every((call) => call.model === 'gpt-5.6-luna' && call.effort === 'low'))
  assert(inference.filter((call) => call.kind === 'start').every((call) => call.toolsDisabled === true))
  if (calls) {
    const analysisCalls = calls.filter((call) => call.kind === 'analysis')
    const argv = analysisCalls[0]?.argv
    assert(Array.isArray(argv))
    assert.equal(argv[argv.indexOf('--model') + 1], 'gpt-5.6-luna')
    assert(argv.includes('model_reasoning_effort="low"'))
    assert.equal(analysisCalls.length, 1, 'Repeated source and restart must not run the model again')
    assert.equal(
      calls.filter(
        (call) =>
          call.kind === 'explicit-chat' ||
          (call.kind === 'rpc' && (call.request as Record<string, unknown>).method === 'turn/start')
      ).length,
      1
    )
  }
  await page.screenshot({ path: join(directory, 'proactive-restarted.png') })
  write('proactive-after-restart.json', { state: afterRestart, conversation: reopened, capture, settings })
  const secondPid = getElectron()?.process().pid
  assert(secondPid)
  await close()
  await waitFor(async () => processGone(secondPid), 'The second native process must exit completely')
  archiveClosedDatabases(directory, 'proactive-final-databases')
  write('proactive-agent-proof.json', {
    passed: true,
    live,
    sourceText,
    initiative: message,
    firstPid,
    secondPid,
    providerCalls: calls,
    inference,
    sourceEvents,
    initialFiles,
    finalFiles,
    sourceToChatWithoutSend: true,
    tasksUnchanged: true,
    exactReceiptAfterRestart: true,
    noPhysicalCapture: true,
    fixtureOnlyContextHelper: true,
    fixtureProvider: !live,
    boundary:
      'Real Electron/IPC/SQLite and full process restart; synthetic AX source. Fixture mode uses deterministic provider text, not model quality. No Mini, cloud Wiki, physical audio or screen capture, release or production enablement.',
  })
  checks.push(
    'Full native quit/restart preserves exact chat/source/dismissal IDs without repeat inference; Tasks and audio remain unchanged'
  )
}

async function proactiveDaySyncQa(options: Parameters<typeof proactiveAgentQa>[0]) {
  const { directory, desktopDirectory, launch, close, getElectron, checks, live = false } = options
  const write = (name: string, value: unknown) => writeFileSync(join(directory, name), JSON.stringify(value, null, 2))
  let page = await launch()
  const initial = inspect(directory)
  const task = options.dayReview
    ? await page.evaluate(
        (title) =>
          window.remember.createWorkItem({
            title,
            description: 'Write a short opening paragraph from the saved Atlas project facts.',
          }),
        dayTaskTitle
      )
    : null
  const tasksBeforeAnalysis = inspect(directory).tasks
  await page.evaluate(() =>
    window.remember.updateSettings({
      offlineMode: false,
      cloudAnalysisConsent: true,
      liveTaskUpdates: true,
      frequentDayRefresh: false,
      audioCaptureEnabled: false,
      capturePaused: true,
      dayAnalysisProvider: 'codex',
      agentLearningEnabled: false,
      interfaceLanguage: 'nl',
    })
  )
  const firstDay = await page.evaluate(() => window.remember.refreshDay('qa-day'))
  assert.equal(firstDay.refresh.run?.status, 'completed')
  assert(
    firstDay.memory?.analysisProvenance?.rawSources.some((source) => source.sourceId === 'qa-day-application-context')
  )
  if (options.dayReview) {
    assert(task)
    assert.equal(firstDay.memory?.summary, live ? liveReviewSummary : daySummary)
    return proactiveDayReviewQa({ ...options, page, initial, taskId: task.id, tasksBeforeAnalysis })
  }
  assert.equal(firstDay.memory?.summary, invitationContext)
  assert.equal(initial.tasks.length, 0, 'Conversational context must not require an open Task')
  const timeout = live ? 90_000 : 45_000
  const clockAdvances: Array<Record<string, unknown>> = []
  const advancePastCooldown = async (reason: string) => {
    const electron = getElectron()
    assert(electron)
    const from = await electron.evaluate(() => Date.now())
    const target = new Date(from + 3 * 60 * 60_000 + 60_000)
    if (target.getHours() < 8) target.setHours(9, 0, 0, 0)
    else if (target.getHours() >= 22) {
      target.setDate(target.getDate() + 1)
      target.setHours(9, 0, 0, 0)
    }
    const to = target.getTime()
    const offset = to - Date.now()
    writeFileSync(join(desktopDirectory, 'proactive-review-clock.json'), JSON.stringify({ offset }))
    await waitFor(
      async () => (await electron.evaluate(() => Date.now())) >= to,
      'The isolated native clock must pass the global cooldown'
    )
    clockAdvances.push({ reason, from, to, offset })
    return to
  }
  const send = async (text: string) => {
    await page.locator('#assistant-message').fill(text)
    await page.getByRole('button', { name: /^(Versturen|Send)$/ }).click()
  }
  const holdForReview = async (stage: string) => {
    if (!live || process.env.REMEMBER_QA_HOLD_REVIEW !== '1') return
    const releaseFile = join(directory, `proactive-day-${stage}-release`)
    const electron = getElectron()
    assert(electron)
    const executable = electron.process().spawnfile
    write('proactive-day-review-visible.json', {
      stage,
      appPath: executable.split('/Contents/')[0],
      executable,
      pid: electron.process().pid,
      releaseFile,
    })
    console.log(
      `Conversational ${stage} visible; awaiting optional CUA inspection: ${join(directory, 'proactive-day-review-visible.json')}`
    )
    const holdUntil = Date.now() + 120_000
    while (!existsSync(releaseFile) && Date.now() < holdUntil) await delay(250)
  }
  await waitFor(
    async () => inspect(directory).receipts.length === 1,
    'Day context must start a conversation without a Task or Send',
    timeout
  )
  const firstConversation = await page.evaluate(() => window.remember.getAssistantConversation())
  const offer = firstConversation.messages.find((message) => message.initiative)
  assert(offer?.initiative)
  assert.equal(offer.replyTo, null)
  assert.equal(firstConversation.messages.length, 1)
  assert.match(offer.initiative.topicKey, /^context:/)
  const firstState = inspect(directory)
  const firstDecision = firstState.decisions.find((decision) => decision.id === offer.initiative?.decisionId)
  assert(firstDecision)
  const interpretedOffer = JSON.parse(String(firstDecision.decision_json))
  assert.equal(interpretedOffer.kind, 'offer')
  assert.deepEqual(interpretedOffer.taskIds, [])
  assert.equal(firstState.tasks.length, 0)
  if (!live) assert.equal(offer.text, invitationOffer)
  assert(offer.text.length <= 400, 'The contextual offer should be a short conversational opening')
  assert.match(offer.text, /uitnodig|bericht|invite|invitation/i)
  assert.equal(await page.getByRole('button', { name: /^(Bronnen|Sources|Nu even niet|Not now)$/ }).count(), 0)
  assert.equal(await page.locator('details summary').count(), 0)
  await page.screenshot({ path: join(directory, 'proactive-day-standard.png') })
  write('proactive-day-delivered.json', { firstDay, firstConversation, firstState })
  await holdForReview('offer')

  await page.setViewportSize({ width: 720, height: 900 })
  const actions = page.locator(`[data-proactive-decision="${offer.initiative.decisionId}"]`)
  const menuButton = actions.getByRole('button', { name: /^(Opties voor bericht|Message options)$/ })
  await menuButton.focus()
  await page.keyboard.press('Enter')
  await page.getByRole('menuitem', { name: /^(Bronnen bekijken|View sources)$/ }).click()
  const sources = page.getByRole('dialog', { name: /^(Bronnen|Sources)$/ })
  await sources.getByRole('heading', { name: /^(Bronnen|Sources)$/ }).waitFor()
  assert((await sources.locator('blockquote').allTextContents()).includes(offer.initiative.sources[0]?.quote ?? ''))
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true)
  await page.screenshot({ path: join(directory, 'proactive-day-sources-720.png') })
  await sources.getByRole('button', { name: /^(Sluiten|Close)$/ }).click()
  await sources.getByRole('heading', { name: /^(Bronnen|Sources)$/ }).waitFor({ state: 'hidden' })
  await page.setViewportSize({ width: 1220, height: 740 })
  checks.push(
    'Task-free Day context produces a natural offer; sources are optional through the keyboard-accessible message menu, with no permanent footer'
  )

  const callsBeforeRepeat = lines(join(desktopDirectory, 'proactive-inference.jsonl')).length
  await page.evaluate(() => window.remember.refreshDay('qa-day'))
  await delay(2_500)
  assert.equal(lines(join(desktopDirectory, 'proactive-inference.jsonl')).length, callsBeforeRepeat)
  await send(acceptOffer)
  await waitFor(
    async () =>
      (await page.evaluate(() => window.remember.getAssistantConversation())).messages.some(
        (message) => message.role === 'assistant' && !message.initiative && message.status === 'completed'
      ),
    'Ordinary ja graag must produce the offered invitation',
    timeout
  )
  const accepted = await page.evaluate(() => window.remember.getAssistantConversation())
  const draft = accepted.messages.find((message) => message.role === 'assistant' && !message.initiative)
  assert(draft?.text && draft.text.length > 60)
  if (!live) assert.equal(draft.text, invitationDraft)
  assert.match(draft.text, /filmavond|movie night/i)
  assert.match(draft.text, /popcorn/i)
  assert.match(draft.text, /bij mij|thuis|my place|home/i)
  assert.match(draft.text, /hé|hey|hoi|zin in|jullie|who|hi\b/i)
  assert.doesNotMatch(
    draft.text,
    /\bop (?:maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag|zondag)\b|\bom \d{1,2}[:.]\d{2}\b/i
  )
  assert.equal(inspect(directory).tasks.length, 0)
  await page.screenshot({ path: join(directory, 'proactive-day-accepted-draft.png') })
  write('proactive-day-accepted.json', { accepted, draft })
  await holdForReview('accepted')
  checks.push(
    'An ordinary ja graag yields a useful invitation using the saved home/popcorn facts without inventing a fixed date or creating Tasks'
  )

  writeFileSync(
    join(desktopDirectory, 'proactive-day-input.json'),
    JSON.stringify({
      summary: filmContext,
      sourceId: 'qa-day-film-context',
      sourceText: filmContext,
    })
  )
  await advancePastCooldown('A distinct later context may produce a second offer after the three-hour global cooldown')
  const secondDay = await page.evaluate(() => window.remember.refreshDay('qa-day'))
  assert.equal(secondDay.refresh.run?.status, 'completed')
  await waitFor(
    async () => inspect(directory).receipts.length === 2,
    'A later film-choice context must produce a distinct offer',
    timeout
  )
  const secondConversation = await page.evaluate(() => window.remember.getAssistantConversation())
  const secondOffer = secondConversation.messages.find((message) => message.initiative && message.id !== offer.id)
  assert(secondOffer?.initiative)
  assert.notEqual(secondOffer.initiative.topicKey, offer.initiative.topicKey)
  const beforeDecline = inspect(directory)
  const secondDecision = beforeDecline.decisions.find((decision) => decision.id === secondOffer.initiative?.decisionId)
  assert(secondDecision && JSON.parse(String(secondDecision.decision_json)).kind === 'offer')
  if (!live) assert.equal(secondOffer.text, filmOffer)
  assert.match(secondOffer.text, /film|movie/i)
  const fixtureCallsBeforeDecline = live ? null : lines(join(desktopDirectory, 'proactive-provider.jsonl')).length
  await send(declineOffer)
  await waitFor(
    async () =>
      (await page.evaluate(() => window.remember.getAssistantConversation())).messages.find(
        (message) => message.id === secondOffer.id
      )?.initiative?.dismissed === true,
    'Ordinary nu even niet must dismiss this exact current offer',
    timeout
  )
  const declined = await page.evaluate(() => window.remember.getAssistantConversation())
  assert.equal(declined.messages.at(-1)?.text, 'Goed, ik laat het voor nu rusten.')
  const afterDecline = inspect(directory)
  assert(afterDecline.dismissals.some((row) => row.topic_key === secondOffer.initiative?.topicKey))
  assert.equal(afterDecline.tasks.length, 0)
  if (!live) assert.equal(lines(join(desktopDirectory, 'proactive-provider.jsonl')).length, fixtureCallsBeforeDecline)
  await page.screenshot({ path: join(directory, 'proactive-day-declined.png') })
  write('proactive-day-declined.json', { secondDay, secondOffer, declined, state: afterDecline })

  const reassessedAfter = await advancePastCooldown(
    'The declined context must remain suppressed beyond the global cooldown'
  )
  await waitFor(
    async () =>
      inspect(directory).reviews.some(
        (review) => Number(review.checked_at) >= reassessedAfter && review.decision_id !== null
      ),
    'The real worker timer must reassess the declined contextual offer',
    timeout
  )
  const beforeRestart = inspect(directory)
  assert.equal(beforeRestart.receipts.length, 2)
  assert.deepEqual(beforeRestart.messages, afterDecline.messages)
  assert.deepEqual(beforeRestart.dismissals, afterDecline.dismissals)
  assert.equal(beforeRestart.tasks.length, 0)
  assert(
    beforeRestart.decisions.every((decision) => JSON.parse(String(decision.decision_json)).reason !== 'analysis-error')
  )
  write('proactive-day-before-restart.json', { state: beforeRestart, clockAdvances })
  checks.push(
    'A natural nu even niet saves a short acknowledgement and durable dismissal; the same context stays quiet after a real scheduled reassessment beyond the global cooldown'
  )

  const firstPid = getElectron()?.process().pid
  assert(firstPid)
  const inferenceBeforeRestart = lines(join(desktopDirectory, 'proactive-inference.jsonl')).length
  await close()
  await waitFor(async () => processGone(firstPid), 'The first native process must fully quit')
  archiveClosedDatabases(directory, 'proactive-day-closed-databases')
  page = await launch()
  await delay(2_500)
  const afterRestart = inspect(directory)
  for (const key of ['messages', 'receipts', 'dismissals', 'tasks', 'reviews', 'schedules'] as const)
    assert.deepEqual(afterRestart[key], beforeRestart[key], `Restart preserves conversational ${key}`)
  assert.deepEqual(afterRestart.audio, initial.audio)
  assert.equal(lines(join(desktopDirectory, 'proactive-inference.jsonl')).length, inferenceBeforeRestart)
  const restartedConversation = await page.evaluate(() => window.remember.getAssistantConversation())
  assert(restartedConversation.messages.find((message) => message.id === secondOffer.id)?.initiative?.dismissed)
  assert.equal(await page.getByRole('button', { name: /^(Bronnen|Sources|Nu even niet|Not now)$/ }).count(), 0)
  const settings = await page.evaluate(() => window.remember.getSettings())
  assert.equal(settings.capturePaused, true)
  assert.equal(settings.audioCaptureEnabled, false)
  assert.equal(lines(join(desktopDirectory, 'proactive-context.jsonl')).length, 0)
  await page.screenshot({ path: join(directory, 'proactive-day-restarted.png') })
  const secondPid = getElectron()?.process().pid
  assert(secondPid)
  await close()
  await waitFor(async () => processGone(secondPid), 'The second native process must fully quit')
  archiveClosedDatabases(directory, 'proactive-day-final-databases')
  const inference = lines(join(desktopDirectory, 'proactive-inference.jsonl'))
  assert(inference.filter((entry) => entry.kind === 'start').every((entry) => entry.toolsDisabled === true))
  write('proactive-day-sync-proof.json', {
    passed: true,
    live,
    firstPid,
    secondPid,
    offer,
    draft,
    secondOffer,
    declined,
    inference,
    clockAdvances,
    state: afterRestart,
    dayRefreshes: lines(join(desktopDirectory, 'proactive-day-refresh.jsonl')),
    boundary:
      'Real Electron IPC, ordinary composer messages, worker timer, SQLite, optional source menu and full restart. Source and Day summaries explicitly use synthetic film-evening context; no Tasks exist. Fixture model text is deterministic; --live uses the actual configured model. Only the isolated main-process clock advances past cooldowns; OS time and installed profile are unchanged. Capture stays paused and audio off. No live Dot, Mini, physical capture, external execution, packaged installation or daily-use quality is claimed.',
  })
  checks.push(
    'Full native quit/restart preserves the conversation, contextual receipts and dismissal with zero Tasks and no repeat inference'
  )
}

async function proactiveDayReviewQa(
  options: Parameters<typeof proactiveAgentQa>[0] & {
    page: Page
    initial: ReturnType<typeof inspect>
    taskId: string
    tasksBeforeAnalysis: ReturnType<typeof inspect>['tasks']
  }
) {
  const {
    directory,
    desktopDirectory,
    launch,
    close,
    getElectron,
    checks,
    initial,
    taskId,
    tasksBeforeAnalysis,
    live = false,
  } = options
  assert(
    live || (new Date().getHours() >= 8 && new Date().getHours() < 22),
    'Run this timer scenario during 08:00–22:00'
  )
  let page = options.page
  const write = (name: string, value: unknown) => writeFileSync(join(directory, name), JSON.stringify(value, null, 2))
  const providerLog = join(desktopDirectory, 'proactive-provider.jsonl')
  const inferenceLog = join(desktopDirectory, 'proactive-inference.jsonl')
  const control = join(desktopDirectory, 'proactive-review-control.json')
  let clockOffset = 0
  let reviewTaskBaseline = tasksBeforeAnalysis
  let clockAdvance: Record<string, unknown> | null = null
  const forceDue = () => {
    const due = Date.now() + clockOffset
    const database = new DatabaseSync(join(directory, 'profile/daily-review/evidence.sqlite'))
    try {
      assert.equal(
        database.prepare('UPDATE proactive_day_schedule SET next_review_at=?,next_attempt_at=?').run(due, due).changes,
        1
      )
    } finally {
      database.close()
    }
    return due
  }
  await waitFor(
    async () => {
      const state = inspect(directory)
      if (!live) return state.followUps.some((entry) => entry.task_id === taskId)
      const sourceIds = new Set(
        state.daySources.filter((row) => String(row.snapshot_json).includes(liveReviewSummary)).map((row) => row.id)
      )
      return state.considered.some((row) =>
        state.events.some((event) => event.event_id === row.event_id && sourceIds.has(event.source_id))
      )
    },
    'The initial Day state must receive a durable assessment',
    live ? 65_000 : 45_000
  )
  const beforeDue = inspect(directory)
  if (!live) assert.equal(beforeDue.receipts.length, 0)
  assert(Number(beforeDue.schedules[0]?.next_review_at) > Date.now())
  const syncSnapshot = beforeDue.daySources
    .map((row) => JSON.parse(String(row.snapshot_json)))
    .find((snapshot) => !snapshot.review && snapshot.text.includes(live ? liveReviewSummary : dayFact))
  assert(syncSnapshot)
  let firstDue: number
  if (live) {
    const afterFollowUps = Math.max(
      Date.now() + 3 * 60 * 60_000,
      ...beforeDue.followUps.map((entry) => Number(entry.next_review_at)),
      ...beforeDue.receipts.map((entry) => Number(JSON.parse(String(entry.payload_json)).createdAt) + 24 * 60 * 60_000)
    )
    const morning = new Date(afterFollowUps)
    morning.setHours(9, 0, 0, 0)
    if (morning.getTime() <= afterFollowUps) morning.setDate(morning.getDate() + 1)
    firstDue = morning.getTime()
    const dueAt = firstDue + 2 * 60 * 60_000
    await page.evaluate(
      ({ id, title, description, dueAt }) =>
        window.remember
          .updateWorkItem(id, { title, description })
          .then(() => window.remember.updateWorkItemMetadata(id, { status: 'in_progress', priority: 'high', dueAt })),
      {
        id: taskId,
        title: dayTaskTitle,
        description: `I, Jan, have committed to writing and sending this application introduction before the recorded deadline. I still need the opening paragraph. ${dayFact} The introduction should explain that project result in the first person.`,
        dueAt,
      }
    )
    reviewTaskBaseline = inspect(directory).tasks
    clockOffset = firstDue - Date.now()
    clockAdvance = { realAt: Date.now(), advancedAt: firstDue, afterFollowUps, dueAt, clockOffset }
    writeFileSync(join(desktopDirectory, 'proactive-review-clock.json'), JSON.stringify({ offset: clockOffset }))
    await waitFor(
      async () => (await getElectron()!.evaluate(() => Date.now())) >= firstDue,
      'Only the isolated Electron main clock must advance past the saved follow-up time'
    )
    write('proactive-day-review-clock-advance.json', { ...clockAdvance, taskBaseline: reviewTaskBaseline })
  } else firstDue = forceDue()
  await waitFor(
    async () =>
      inspect(directory).reviews.some((review) => Number(review.checked_at) >= firstDue && review.decision_id !== null),
    'The native timer must review unchanged Tasks without another refresh or Send',
    live ? 65_000 : 45_000
  )
  const firstReview = inspect(directory)
  const completedReview = firstReview.reviews.find(
    (review) => Number(review.checked_at) >= firstDue && review.decision_id !== null
  )
  const reviewDecision = firstReview.decisions.find((decision) => decision.id === completedReview?.decision_id)
  assert(reviewDecision && JSON.parse(String(reviewDecision.decision_json)).reason === 'interpreted')
  const reviewedSnapshot = firstReview.daySources
    .map((row) => JSON.parse(String(row.snapshot_json)))
    .find((snapshot) => snapshot.review?.checkedAt >= firstDue)
  assert(reviewedSnapshot)
  if (!live) assert.equal(reviewedSnapshot.semanticRevision, syncSnapshot.semanticRevision)
  assert.equal(reviewedSnapshot.review.reason, 'scheduled-task-review')
  assert.deepEqual(firstReview.tasks, reviewTaskBaseline)
  assert.equal(lines(join(desktopDirectory, 'proactive-day-refresh.jsonl')).length, 1)
  const conversation = await page.evaluate(() => window.remember.getAssistantConversation())
  const initiative = conversation.messages.find((message) =>
    live ? message.initiative?.decisionId === completedReview?.decision_id : message.initiative
  )
  if (!live) {
    assert(initiative?.initiative)
    assert.equal(initiative.text, dayInitiative)
    assert.equal(firstReview.receipts.length, 1)
  }
  if (live) {
    assert(initiative?.initiative, 'The elapsed-time review must produce useful visible help for the committed task')
    assert.equal(firstReview.receipts.length, beforeDue.receipts.length + 1)
    assert.match(initiative.text, /TypeScript/i)
    assert.match(initiative.text, /six|zes|6/i)
    assert.match(initiative.text, /two|twee|2/i)
    assert.match(initiative.text, /draft|opening|concept|intro|paragraph|alinea|[“"]/i)
  }
  if (initiative?.initiative) {
    assert.equal(initiative.replyTo, null)
    assert.equal(initiative.initiative.topicKey, `task:${taskId}`)
    await page.locator(`[data-assistant-message="${initiative.id}"]`).waitFor()
  }
  await page.screenshot({ path: join(directory, 'proactive-day-review.png') })
  write('proactive-day-review-delivered.json', { beforeDue, firstDue, firstReview, initiative, clockAdvance })
  if (live && process.env.REMEMBER_QA_HOLD_REVIEW === '1') {
    const releaseFile = join(directory, 'proactive-day-review-release')
    const executable = getElectron()!.process().spawnfile
    write('proactive-day-review-visible.json', {
      appPath: executable.split('/Contents/')[0],
      executable,
      pid: getElectron()!.process().pid,
      releaseFile,
      initiative,
    })
    console.log(
      `Scheduled proposal visible; awaiting optional CUA inspection: ${join(directory, 'proactive-day-review-visible.json')}`
    )
    const holdUntil = Date.now() + 120_000
    while (!existsSync(releaseFile) && Date.now() < holdUntil) await delay(250)
  }
  checks.push(
    live
      ? 'After process-local elapsed time passes the saved follow-up date, the real model writes a concrete application draft from the current committed Task facts'
      : 'A durable due time drives the real native timer to help an unchanged Task without Day refresh or Send'
  )

  forceDue()
  await waitFor(
    async () => inspect(directory).decisions.length > firstReview.decisions.length,
    'A second scheduled review must be assessed',
    live ? 65_000 : 45_000
  )
  await delay(2_500)
  const afterRepeat = inspect(directory)
  assert.equal(
    afterRepeat.receipts.length,
    firstReview.receipts.length,
    'Repeated model offers for the same task must respect the cooldown'
  )
  assert.deepEqual(afterRepeat.tasks, reviewTaskBaseline)
  checks.push(
    live
      ? 'Repeated scheduled real-model assessments do not duplicate same-task chat'
      : 'The same-task cooldown suppresses a repeated useful-looking model offer on the next scheduled review'
  )

  if (!live) {
    writeFileSync(control, JSON.stringify({ hold: true }))
    const callsBeforeHold = lines(providerLog).length
    const interruptedDue = forceDue()
    await waitFor(
      async () =>
        lines(providerLog)
          .slice(callsBeforeHold)
          .some((entry) => entry.kind === 'analysis-held'),
      'The controlled provider must hold a real scheduled inference'
    )
    const beforeInterruption = inspect(directory)
    await page.locator('#assistant-message').fill(dayQuestion)
    await page.getByRole('button', { name: /^(Versturen|Send)$/ }).click()
    await waitFor(
      async () =>
        lines(providerLog)
          .slice(callsBeforeHold)
          .some((entry) => entry.kind === 'analysis-cancelled'),
      'Ordinary user chat must cancel the running background provider process'
    )
    const interrupted = inspect(directory)
    assert.equal(interrupted.decisions.length, beforeInterruption.decisions.length)
    assert.equal(interrupted.receipts.length, 1)
    assert.equal(interrupted.schedules[0]?.next_review_at, interruptedDue)
    assert(
      interrupted.reviews.some((review) => Number(review.checked_at) >= interruptedDue && review.decision_id === null)
    )
    write('proactive-day-review-interrupted.json', { interruptedDue, beforeInterruption, interrupted })
    writeFileSync(control, JSON.stringify({ hold: false }))
    await waitFor(
      async () =>
        (await page.evaluate(() => window.remember.getAssistantConversation())).messages.some(
          (message) => message.role === 'assistant' && !message.initiative && message.text === dayAnswer
        ),
      'Ordinary user chat must complete after preemption'
    )
    await waitFor(
      async () =>
        inspect(directory).reviews.some(
          (review) => Number(review.checked_at) >= interruptedDue && review.decision_id !== null
        ),
      'The interrupted scheduled slot must finish after user work without losing its due review'
    )
    assert.equal(inspect(directory).receipts.length, 1)
    checks.push(
      'User Send cancels the actual held background process; its pending slot later completes without duplicate chat'
    )
  }

  await page.evaluate((id) => window.remember.setWorkItemLifecycle(id, 'completed'), taskId)
  const beforeCompletion = inspect(directory)
  forceDue()
  await waitFor(
    async () => inspect(directory).decisions.length > beforeCompletion.decisions.length,
    'The timer must assess current task completion without another Day synthesis',
    live ? 65_000 : 45_000
  )
  const beforeRestart = inspect(directory)
  assert(
    beforeRestart.decisions.every((decision) => JSON.parse(String(decision.decision_json)).reason !== 'analysis-error'),
    'A model failure must not count as a successful silent assessment'
  )
  assert.equal(beforeRestart.receipts.length, afterRepeat.receipts.length)
  assert.equal(beforeRestart.followUps.length, 0, 'Completed Tasks must leave the durable follow-up set')
  assert.equal(beforeRestart.tasks.find((task) => task.id === taskId)?.lifecycle, 'completed')
  assert.equal(lines(join(desktopDirectory, 'proactive-day-refresh.jsonl')).length, 1)
  assert(beforeRestart.reviews.every((review) => review.decision_id !== null))
  write('proactive-day-review-before-restart.json', beforeRestart)
  const callsBeforeRestart = lines(inferenceLog).filter((entry) => entry.kind === 'start').length
  const firstPid = getElectron()?.process().pid
  assert(firstPid)
  await close()
  await waitFor(async () => processGone(firstPid), 'The first native review process must fully quit')
  archiveClosedDatabases(directory, 'proactive-day-review-closed-databases')
  page = await launch()
  await delay(2_500)
  const afterRestart = inspect(directory)
  for (const key of ['messages', 'receipts', 'tasks', 'schedules', 'reviews', 'followUps'] as const)
    assert.deepEqual(afterRestart[key], beforeRestart[key], `Restart preserves ${key}`)
  assert.deepEqual(afterRestart.audio, initial.audio)
  assert.equal(lines(inferenceLog).filter((entry) => entry.kind === 'start').length, callsBeforeRestart)
  assert.equal(lines(join(desktopDirectory, 'proactive-context.jsonl')).length, 0)
  const settings = await page.evaluate(() => window.remember.getSettings())
  assert.equal(settings.capturePaused, true)
  assert.equal(settings.audioCaptureEnabled, false)
  assert.equal(settings.liveTaskUpdates, true)
  await page.screenshot({ path: join(directory, 'proactive-day-review-restarted.png') })
  const secondPid = getElectron()?.process().pid
  assert(secondPid)
  await close()
  await waitFor(async () => processGone(secondPid), 'The second native review process must fully quit')
  archiveClosedDatabases(directory, 'proactive-day-review-final-databases')
  write('proactive-day-review-proof.json', {
    passed: true,
    live,
    taskId,
    firstPid,
    secondPid,
    initiative,
    state: afterRestart,
    providerCalls: live ? null : lines(providerLog),
    inference: lines(inferenceLog),
    initialAssessmentPublished: beforeDue.receipts.length > 0,
    scheduledAssessmentPublished: firstReview.receipts.length > beforeDue.receipts.length,
    userPreemptionChecked: !live,
    clockAdvance,
    boundary:
      'Real Electron IPC, worker timer, SQLite schedules, task completion and complete restart. Fixture mode accelerates only due timestamps; live mode advances only the isolated Electron main clock and records a synthetic human Task update with facts and deadline. The OS clock and installed profile are untouched. Initial Day summary is synthetic. Provider and user preemption are deterministic in fixture mode; --live requires actual model output with a useful scheduled draft. No natural three-hour passage, sleep/wake, Mini, physical capture, external research or installed-app behavior is claimed.',
  })
  checks.push(
    'Task completion cancels its follow-up; exact schedule, receipts and task/chat state survive complete native quit/restart'
  )
}
