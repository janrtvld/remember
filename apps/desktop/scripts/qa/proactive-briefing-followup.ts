import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import type { AssistantConversation } from '@remember/shared'
import type { ElectronApplication, Locator, Page } from 'playwright-core'
import { validateBriefingNativeManifest } from '../../src/main/briefingNativeCore'
import { installProactiveAgentFixture } from './proactive-agent'

export {
  seedProactiveBriefingProfile as seedProactiveBriefingFollowupProfile,
  setupProactiveBriefingQa as setupProactiveBriefingFollowupQa,
} from './proactive-briefing'

type Row = Record<string, unknown>
type Setup = {
  root: string
  manifestPath: string
  childPids: number[]
  sources: { id: string; text: string; topic: string }[]
}
const question = 'Waarom deze briefing? Welk bewijs ontbreekt nog?'
const answer = 'Synthetische QA-uitleg: de prijsreview komt eraan; volumeschatting en acceptatiecriteria ontbreken.'
const reasoning = 'Synthetische QA-redenering bij uitsluitend het actuele Atlas-concept.'
const afterQuestion = 'Wat kun je nu nog zeggen over deze briefing?'
const afterAnswer = 'Synthetische QA-controle: het eerdere concept en de afgeleide uitleg zijn niet beschikbaar.'
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const json = (value: unknown) => JSON.stringify(value, null, 2)
const lines = (file: string): Row[] =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : []
function manifest() {
  const filename = process.env.REMEMBER_QA_BRIEFING_MANIFEST
  assert(filename && filename.startsWith('/private/tmp/'), 'Own absolute manifest required')
  return validateBriefingNativeManifest(JSON.parse(readFileSync(filename, 'utf8')))
}
function replaceOnce(file: string, pattern: RegExp, replacement: string) {
  const text = readFileSync(file, 'utf8')
  assert.equal([...text.matchAll(new RegExp(pattern, 'g'))].length, 1, `One copied fixture boundary in ${file}`)
  writeFileSync(file, text.replace(pattern, replacement))
}

/** Only source ingress, logging and executable discovery change in the copied runtime. */
export function installProactiveBriefingFollowupFixture(desktopDirectory: string) {
  assert(!desktopDirectory.endsWith('/apps/desktop'), 'Never install a fixture into the checkout')
  const value = manifest()
  const setup = JSON.parse(
    readFileSync(join(dirname(value.profilePath), 'proactive-briefing-setup.json'), 'utf8')
  ) as Setup
  installProactiveAgentFixture(desktopDirectory, { skipCodexFixture: true })
  replaceOnce(
    join(desktopDirectory, 'src/main/dailyReview/index.ts'),
    /const context: DailyReviewContextMoment = \{ id: randomUUID\(\), bundleId, \.\.\.capturedContext \}/,
    `const context: DailyReviewContextMoment = { id: (${JSON.stringify(setup.sources)}).find(source => source.text === capturedContext.text)?.id ?? randomUUID(), bundleId, ...capturedContext }`
  )
  const trace = join(value.root, 'followup-observer-chat.jsonl')
  const expected = join(value.root, 'followup-expected.json')
  const executable = join(desktopDirectory, 'briefing-followup-fixture.cjs')
  writeFileSync(trace, '')
  writeFileSync(
    executable,
    `#!${process.execPath}
const assert=require('node:assert/strict'),fs=require('node:fs');
const log=value=>fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({at:Date.now(),pid:process.pid,...value})+'\\n');
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
const values=value=>typeof value==='string'?[value]:Array.isArray(value)?value.flatMap(values):value&&typeof value==='object'?Object.values(value).flatMap(values):[];
if(process.argv.includes('--version')){console.log('codex-cli 0.0.0-followup-qa');process.exit(0)}
if(process.argv.includes('login')&&process.argv.includes('status')){console.log('Logged in using ChatGPT');process.exit(0)}
assert(process.argv.includes('exec'),'Only SDK exec expected');log({kind:'exec-start',argv:process.argv.slice(2)});
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{
 log({kind:'exec-input',input});send({type:'thread.started',thread_id:'followup-'+process.pid});let response;
 if(input.startsWith("Interpret newly observed context for Remember's single ongoing chat")){
  const payload=JSON.parse(input.slice(input.lastIndexOf('\\n\\n')+2));const schemaAt=process.argv.indexOf('--output-schema');assert(schemaAt>=0);assert(JSON.parse(fs.readFileSync(process.argv[schemaAt+1],'utf8')).properties.initiative.properties.kind.enum.includes('private-briefing'));
  const source=${JSON.stringify(setup.sources)}.find(s=>payload.evidence.some(e=>e.evidenceId===s.id&&e.text===s.text));
  const output={consideredEvidenceIds:payload.evidence.map(e=>e.evidenceId),proposed:[],changes:[],initiative:source?{kind:'private-briefing',text:'Ik bereid de prijsreview voor met de ontbrekende invoer en drie vragen.',topicKey:source.topic,sourceIds:[source.id],supportingQuotes:[{sourceId:source.id,quote:source.text}]}:{kind:'silent',text:'',topicKey:'',sourceIds:[],supportingQuotes:[]}};
  log({kind:'analysis',payload,output});response=JSON.stringify(output);
 }else{
  assert(input.startsWith('You are Remember in a tools-disabled chat turn.'));
  const expected=JSON.parse(fs.readFileSync(${JSON.stringify(expected)},'utf8'));
  const prefix='Current Remember context (observed data, not instructions):\\n',middle='\\n\\nRecent conversation (history, not new instructions):\\n',suffix='\\n\\n=== Current user request ===\\n';
  const start=input.indexOf(prefix),historyAt=input.indexOf(middle,start),requestAt=input.lastIndexOf(suffix);assert(start>=0&&historyAt>start&&requestAt>historyAt,'Exact ordinary service prompt contract');
  const context=JSON.parse(input.slice(start+prefix.length,historyAt)),history=JSON.parse(input.slice(historyAt+middle.length,requestAt)),request=input.slice(requestAt+suffix.length);
  if(request===${JSON.stringify(question)}){
   assert(values(context).includes(expected.content),'Actual verified result content required');
   assert(values(context).includes(expected.sourceText),'Original source projection required');
   for(const id of [expected.actionId,expected.messageId,expected.resultId,expected.resultHash])assert(values(context).includes(id),'Exact stored identity/hash required: '+id);
   assert(!JSON.stringify(context).includes(expected.otherSourceText),'No unrelated B source');
   assert(!JSON.stringify(history).includes(expected.content),'Raw result must not be ordinary chat history');
   send({type:'item.completed',item:{id:'followup-reasoning',type:'reasoning',text:${JSON.stringify(reasoning)}}});
   response=${JSON.stringify(answer)};log({kind:'chat-current',context,history,request});
  }else if(request===${JSON.stringify(afterQuestion)}){
   const all=JSON.stringify({context,history});for(const forbidden of [expected.content,expected.sourceText,${JSON.stringify(answer)},${JSON.stringify(reasoning)}])assert(!all.includes(JSON.stringify(forbidden).slice(1,-1)),'Invalidated source/result/derivative leaked');
   response=${JSON.stringify(afterAnswer)};log({kind:'chat-after-edit',context,history,request});
  }else throw Error('Unexpected ordinary question');
 }
 send({type:'item.completed',item:{id:'followup-answer',type:'agent_message',text:response}});send({type:'turn.completed',usage:{input_tokens:1,cached_input_tokens:0,output_tokens:1}});log({kind:'completed'});
});
`,
    { mode: 0o700 }
  )
  replaceOnce(
    join(desktopDirectory, 'src/main/codexRuntime.ts'),
    /export function bundledCodexExecutable\(\) \{[\s\S]*?\n\}/,
    `export function bundledCodexExecutable() { return ${JSON.stringify(executable)} }`
  )
}

async function waitFor<T>(read: () => Promise<T | false | null>, label: string, timeout = 30_000): Promise<T> {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await read()
    if (value !== null && value !== false) return value
    assert(Date.now() < deadline, label)
    await delay(100)
  }
}
function gone(pid: number) {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true
    throw error
  }
}
function rows(file: string, tables?: string[]) {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const names =
      tables ??
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'assistant_%' ORDER BY name")
        .all()
        .map((row) => String(row.name))
    return Object.fromEntries(
      names.map((name) => {
        assert(/^[a-z_]+$/.test(name))
        return [
          name,
          db
            .prepare(`SELECT * FROM ${name}`)
            .all()
            .map((row) => ({ ...row })),
        ]
      })
    ) as Record<string, Row[]>
  } finally {
    db.close()
  }
}
function nativeFacts(profile: string) {
  return {
    evidence: rows(join(profile, 'daily-review/evidence.sqlite'), [
      'work_item',
      'audio_evidence',
      'context_evidence',
      'proactive_consumer',
      'proactive_decision',
    ]),
    resident: rows(join(profile, 'daily-review/assistant/conversation.sqlite')),
  }
}
function hostFacts(directory: string) {
  return rows(join(directory, 'briefing.sqlite'), ['metadata', 'job', 'event', 'write_intent'])
}
function filesAt(directory: string): string[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesAt(join(directory, entry.name)) : [join(directory, entry.name)]
  )
}
function archiveClosed(profile: string, target: string) {
  mkdirSync(target, { recursive: true })
  for (const [label, relative] of [
    ['evidence', 'daily-review/evidence.sqlite'],
    ['resident', 'daily-review/assistant/conversation.sqlite'],
  ]) {
    for (const suffix of ['', '-wal', '-shm']) {
      const source = join(profile, relative + suffix)
      if (existsSync(source)) copyFileSync(source, join(target, label + '.sqlite' + suffix))
    }
  }
}
async function keyboard(button: Locator) {
  await button.waitFor({ state: 'visible' })
  await button.focus()
  assert(await button.evaluate((element) => document.activeElement === element))
  await button.press('Enter')
}

export async function proactiveBriefingFollowupQa({
  directory,
  desktopDirectory,
  launch,
  close,
  getElectron,
  checks,
}: {
  directory: string
  desktopDirectory: string
  launch(): Promise<Page>
  close(): Promise<void>
  getElectron(): ElectronApplication | undefined
  checks: string[]
}) {
  const value = manifest()
  const setup = JSON.parse(readFileSync(join(directory, 'proactive-briefing-setup.json'), 'utf8')) as Setup
  const profile = value.profilePath
  const pids: number[] = []
  const proof: Row = {
    startedAt: Date.now(),
    setup,
    manifest: value,
    boundary:
      'Real isolated Electron/IPC/stores/SDK/local fixed-file host. Synthetic AX ingress and fake observer, briefing and ordinary chat. Actual revision-checked Personal edit. No new real model, Mini, cloud, physical capture, audio or release.',
  }
  const save = () => writeFileSync(join(directory, 'proactive-briefing-followup-proof.json'), json(proof))
  let page: Page | null = null
  const cleanupErrors: string[] = []
  const snapshot = (target: Page) => target.evaluate(() => window.remember.getAssistantConversation())
  const start = async () => {
    const target = await launch()
    target.setDefaultTimeout(20_000)
    target.setDefaultNavigationTimeout(90_000)
    const pid = getElectron()?.process().pid
    assert(pid)
    pids.push(pid)
    await target.goto(`${new URL(target.url()).origin}/assistant/`)
    await waitFor(async () => (await snapshot(target)).briefingsEnabled || null, 'Briefing owner ready')
    assert.equal((await target.evaluate(() => window.remember.getSettings())).audioCaptureEnabled, false)
    return target
  }
  const quit = async (label: string) => {
    const pid = pids.at(-1)
    assert(pid)
    await close()
    page = null
    await waitFor(async () => gone(pid) || null, 'Full native quit must remove PID', 15_000)
    archiveClosed(profile, join(directory, label))
    proof[label] = { pid, gone: true, at: Date.now() }
    save()
  }
  const exactA = () => {
    const matched = nativeFacts(profile).resident.assistant_initiative_action.filter(
      (row) => row.job_id === value.slots[0].jobId
    )
    assert.equal(matched.length, 1)
    return matched[0]
  }
  const actionA = (state: AssistantConversation) =>
    state.messages.find((message) => message.id === exactA().assistant_message_id)?.briefingAction
  const send = async (target: Page, text: string, expected: string) => {
    const before = new Set((await snapshot(target)).messages.map((message) => message.id))
    const input = target.locator('#assistant-message')
    await input.fill(text)
    assert.equal(await input.inputValue(), text)
    await input.press('Enter')
    return waitFor(async () => {
      const found = (await snapshot(target)).messages.find(
        (message) =>
          !before.has(message.id) &&
          message.role === 'assistant' &&
          message.status === 'completed' &&
          message.text === expected
      )
      return found ?? null
    }, 'Actual ordinary composer answer must complete')
  }
  try {
    page = await start()
    await page.setViewportSize({ width: 1040, height: 900 })
    const initial = nativeFacts(profile)
    assert.equal(initial.resident.assistant_message.length, 0)
    assert(value.slots.every((slot) => hostFacts(slot.directory).job.length === 0))
    const title = 'Atlas en Cedar',
      slug = value.source.slug
    const created = (
      await page.evaluate(
        ({ slug, title }) => window.remember.createWikiPage({ spaceId: 'personal', category: 'projects', slug, title }),
        { slug, title }
      )
    ).find((entry) => entry.slug === slug)
    assert(created?.revision)
    const content =
      '# Atlas en Cedar\n\nAtlas: de volumeschatting en acceptatiecriteria ontbreken.\n\nCedar: the launch owner and rollback criteria are undecided.\n\nDit is uitsluitend synthetische QA-context.'
    const personal = (
      await page.evaluate(
        ({ slug, title, content, expectedRevision }) =>
          window.remember.saveWikiPage({
            spaceId: 'personal',
            slug,
            title,
            content,
            expectedRevision,
            strictRevision: true,
          }),
        { slug, title, content, expectedRevision: created.revision }
      )
    ).find((entry) => entry.slug === slug)
    assert(personal?.revision)
    await page.evaluate(() =>
      window.remember.createWorkItem({
        title: 'Handmatige taak blijft open',
        description: 'RPA-5 mag deze taak niet aanpassen.',
      })
    )
    const baseline = nativeFacts(profile)
    const mediaBefore = filesAt(profile).filter((file) => /\.(png|jpe?g|webp|wav|m4a|mp3|aiff)$/i.test(file))
    proof.baseline = { native: baseline, personal, mediaBefore }
    await page.evaluate(() =>
      window.remember.updateSettings({
        liveTaskUpdates: true,
        audioCaptureEnabled: false,
        capturePaused: false,
        captureSchedule: { enabled: false, weekdays: [1, 2, 3, 4, 5], startTime: '09:00', endTime: '17:00' },
      })
    )
    await page.evaluate(() => window.remember.resumeCapture())
    await waitFor(
      async () =>
        ((await page!.evaluate(() => window.remember.getState())).status === 'recording' &&
          nativeFacts(profile).evidence.proactive_consumer.some((row) => row.enabled === 1)) ||
        null,
      'Synthetic writer/consumer must be ready'
    )
    await keyboard(page.getByRole('button', { name: 'Privévoorwerk toestaan', exact: true }))
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('heading', { name: 'Privévoorwerk toestaan', exact: true }).waitFor({ state: 'visible' })
    assert((await dialog.innerText()).includes(slug))
    await keyboard(dialog.getByRole('button', { name: 'Toestaan', exact: true }))
    await waitFor(async () => (await snapshot(page!)).briefingGrant ?? null, 'Grant must persist')
    proof.sourceAAt = Date.now()
    writeFileSync(join(desktopDirectory, 'proactive-native-input.json'), json({ text: setup.sources[0].text }))
    const a = await waitFor(
      async () => {
        const state = await snapshot(page!)
        if (!nativeFacts(profile).resident.assistant_initiative_action.length) return null
        const found = actionA(state)
        return found?.state === 'completed' && found.result ? found : null
      },
      'A must complete through native owner and actual local fixed-file writer',
      60_000
    )
    writeFileSync(join(desktopDirectory, 'proactive-native-input.json'), json({ text: '' }))
    const aRow = exactA()
    const result = JSON.parse(String(aRow.result_json)) as {
      content: string
      receipt: { contentHash: string; byteLength: number; resultId: string }
    }
    const aFile = join(value.slots[0].workspace, 'briefing.md')
    assert.equal(readFileSync(aFile, 'utf8'), result.content)
    assert.equal(hash(readFileSync(aFile)), result.receipt.contentHash)
    assert.equal(readFileSync(aFile).length, result.receipt.byteLength)
    assert.equal(a.result!.id, result.receipt.resultId)
    const hostA = hostFacts(value.slots[0].directory)
    assert.equal(hostA.event.filter((event) => event.type === 'write-consumed').length, 1)
    assert.equal(hostA.event.filter((event) => event.type === 'completed').length, 1)
    assert.equal(hostFacts(value.slots[1].directory).job.length, 0)
    writeFileSync(
      join(setup.root, 'followup-expected.json'),
      json({
        content: result.content,
        sourceText: setup.sources[0].text,
        otherSourceText: setup.sources[1].text,
        actionId: a.actionId,
        messageId: a.messageId,
        resultId: result.receipt.resultId,
        resultHash: aRow.result_hash,
        contentHash: result.receipt.contentHash,
      })
    )
    await keyboard(page.getByRole('button', { name: 'Voorwerk pauzeren', exact: true }))
    await waitFor(async () => ((await snapshot(page!)).briefingGrant ? null : true), 'Execution grant must pause')
    assert.deepEqual(actionA(await snapshot(page)), a)
    const wireBefore = lines(join(setup.root, 'native-wire.jsonl')).length
    const aCard = page.locator(`[data-briefing-action="${a.actionId}"]`)
    await keyboard(aCard.getByRole('button', { name: 'Concept openen', exact: true }))
    await dialog.getByRole('heading', { name: title, exact: true }).waitFor({ state: 'visible' })
    assert((await dialog.innerText()).includes('volumeschatting'))
    await page.screenshot({ path: join(directory, 'followup-a-open-standard.png') })
    await keyboard(dialog.getByRole('button', { name: 'Sluiten', exact: true }))
    const input = page.locator('#assistant-message')
    await input.fill(question)
    assert.equal(
      lines(join(setup.root, 'followup-observer-chat.jsonl')).filter((entry) => entry.kind === 'chat-current').length,
      0
    )
    assert.equal(lines(join(setup.root, 'native-wire.jsonl')).length, wireBefore)
    await input.fill('')
    const reply = await send(page, question, answer)
    assert(reply.steps.some((step) => step.text === reasoning))
    await page.getByText(answer, { exact: true }).waitFor({ state: 'visible' })
    await page.screenshot({ path: join(directory, 'followup-answer-standard.png') })
    await page.setViewportSize({ width: 720, height: 900 })
    await page.screenshot({ path: join(directory, 'followup-answer-720.png') })
    const native = nativeFacts(profile)
    const lineageRows = native.resident.assistant_reply_context.filter((row) => row.message_id === reply.id)
    assert.equal(lineageRows.length, 1, 'One exact durable ordinary-answer lineage record')
    const lineageRow = lineageRows[0]
    assert.deepEqual(JSON.parse(String(lineageRow.references_json)), [
      {
        actionId: a.actionId,
        messageId: a.messageId,
        resultId: result.receipt.resultId,
        resultHash: aRow.result_hash,
      },
    ])
    const lineage = [{ table: 'assistant_reply_context', row: lineageRow }]
    assert(!JSON.stringify(lineage).includes(JSON.stringify(result.content).slice(1, -1)))
    assert.equal(lines(join(setup.root, 'native-wire.jsonl')).length, wireBefore)
    assert.deepEqual(native.evidence.work_item, baseline.evidence.work_item)
    assert.deepEqual(native.evidence.audio_evidence, baseline.evidence.audio_evidence)
    proof.a = { action: a, row: aRow, result, file: aFile, host: hostA }
    proof.followup = { reply, lineage, native, wireBefore, wireAfter: wireBefore, at: Date.now() }
    checks.push(
      'Paused completed A supplies its exact verified content/sources to ordinary tools-disabled chat; reply has durable lineage without host contact'
    )
    await quit('followup-quit-permitted')
    page = await start()
    await page.setViewportSize({ width: 720, height: 900 })
    const recovered = await snapshot(page)
    assert.deepEqual(actionA(recovered), a)
    assert.deepEqual(
      recovered.messages.find((message) => message.id === reply.id),
      reply
    )
    assert.equal(exactA().result_json, aRow.result_json)
    assert.equal(exactA().terminal_received_at, aRow.terminal_received_at)
    assert.equal(lines(join(setup.root, 'native-wire.jsonl')).length, wireBefore)
    for (const entry of lineage)
      assert.deepEqual(
        nativeFacts(profile).resident[entry.table].find((row) => row.message_id === reply.id),
        entry.row
      )
    await page.getByText(answer, { exact: true }).waitFor({ state: 'visible' })
    await page.screenshot({ path: join(directory, 'followup-restarted-permitted-720.png') })
    proof.restartPermitted = { state: recovered, native: nativeFacts(profile), at: Date.now() }
    checks.push('First full native quit preserves A and ordinary answer/lineage/time without model or host replay')
    const editedContent =
      '# Atlas en Cedar\n\nDeze synthetische bron is gewijzigd; het vorige concept is niet meer actueel.'
    const edited = (
      await page.evaluate(
        ({ slug, title, content, expectedRevision }) =>
          window.remember.saveWikiPage({
            spaceId: 'personal',
            slug,
            title,
            content,
            expectedRevision,
            strictRevision: true,
          }),
        { slug, title, content: editedContent, expectedRevision: personal.revision }
      )
    ).find((entry) => entry.slug === slug)
    assert(edited?.revision)
    assert.notEqual(edited.revision, personal.revision)
    const withheld = await waitFor(async () => {
      const current = await snapshot(page!)
      const original = current.messages.find((message) => message.id === reply.id)
      return actionA(current)?.state === 'withheld' && original && original.text === '' && original.steps.length === 0
        ? current
        : null
    }, 'Real source edit must withhold A and its derivative text/steps')
    await waitFor(
      async () => !(await page!.locator('body').innerText()).includes(answer) || null,
      'Old derived text must disappear from actual renderer'
    )
    assert.equal(
      await page
        .locator(`[data-briefing-action="${a.actionId}"]`)
        .getByRole('button', { name: 'Concept openen', exact: true })
        .count(),
      0
    )
    await page.screenshot({ path: join(directory, 'followup-source-edited-720.png') })
    const afterReply = await send(page, afterQuestion, afterAnswer)
    assert.equal(lines(join(setup.root, 'native-wire.jsonl')).length, wireBefore)
    proof.sourceEdit = { edited, withheld, afterReply, at: Date.now(), native: nativeFacts(profile) }
    checks.push(
      'Real revision-checked Personal edit withholds result and derivative; subsequent composer prompt contains neither old sources, result nor derived history'
    )
    await page.evaluate(() => window.remember.pauseCapture({ durationMs: null, sources: ['audio', 'capture'] }))
    await quit('followup-quit-invalidated')
    page = await start()
    await page.setViewportSize({ width: 720, height: 900 })
    const final = await snapshot(page)
    assert.equal(actionA(final)?.state, 'withheld')
    const removed = final.messages.find((message) => message.id === reply.id)
    assert(removed)
    assert.equal(removed.text, '')
    assert.deepEqual(removed.steps, [])
    assert.equal(final.messages.find((message) => message.id === afterReply.id)?.text, afterAnswer)
    const finalNative = nativeFacts(profile)
    assert.deepEqual(finalNative.evidence.work_item, baseline.evidence.work_item)
    assert.deepEqual(finalNative.evidence.audio_evidence, baseline.evidence.audio_evidence)
    assert.equal(finalNative.resident.assistant_initiative_action.length, 1)
    assert.equal(exactA().terminal_received_at, aRow.terminal_received_at)
    assert.equal(hash(readFileSync(aFile)), result.receipt.contentHash)
    assert.equal(lines(join(setup.root, 'native-wire.jsonl')).length, wireBefore)
    assert.equal(hostFacts(value.slots[1].directory).job.length, 0)
    const fixtureCalls = lines(join(setup.root, 'followup-observer-chat.jsonl'))
    assert.equal(fixtureCalls.filter((entry) => entry.kind === 'exec-start').length, 3)
    assert.equal(fixtureCalls.filter((entry) => entry.kind === 'completed').length, 3)
    assert.equal(fixtureCalls.filter((entry) => entry.kind === 'analysis').length, 1)
    assert.equal(fixtureCalls.filter((entry) => entry.kind === 'chat-current').length, 1)
    assert.equal(fixtureCalls.filter((entry) => entry.kind === 'chat-after-edit').length, 1)
    assert.equal(lines(join(setup.root, 'host-sdk.jsonl')).filter((entry) => entry.kind === 'exec-start').length, 1)
    for (const call of [...fixtureCalls, ...lines(join(setup.root, 'host-sdk.jsonl'))].filter(
      (entry) => entry.kind === 'exec-start'
    )) {
      const args = (call.argv as string[]).join(' ')
      assert.match(args, /shell_tool=false/)
      assert.match(args, /network_access=false/)
      assert.match(args, /--sandbox read-only/)
    }
    const mediaAfter = filesAt(profile).filter((file) => /\.(png|jpe?g|webp|wav|m4a|mp3|aiff)$/i.test(file))
    assert.deepEqual(mediaAfter, mediaBefore)
    const settings = await page.evaluate(() => window.remember.getSettings())
    assert.equal(settings.audioCaptureEnabled, false)
    assert.equal(settings.capturePaused, true)
    await page.getByText(afterAnswer, { exact: true }).waitFor({ state: 'visible' })
    await page.screenshot({ path: join(directory, 'followup-invalidated-restarted-720.png') })
    proof.final = {
      state: final,
      native: finalNative,
      settings: { audioCaptureEnabled: false, capturePaused: true },
      hosts: value.slots.map((slot) => hostFacts(slot.directory)),
      mediaAfter,
      fixtureCalls,
    }
    checks.push(
      'Second full native quit retains source invalidation; one host invocation, two ordinary answers, unchanged human Tasks/audio and no effect replay'
    )
    await quit('followup-final-close')
    proof.nativePids = pids.map((pid) => ({ pid, gone: gone(pid) }))
    assert(pids.every(gone))
    proof.status = 'passed'
    proof.completedAt = Date.now()
    save()
  } catch (error) {
    proof.status = 'failed'
    proof.error = error instanceof Error ? { message: error.message, stack: error.stack } : String(error)
    try {
      proof.failureNative = nativeFacts(profile)
    } catch (readError) {
      proof.readError = String(readError)
    }
    try {
      save()
    } catch (archiveError) {
      cleanupErrors.push(`initial failure archive: ${String(archiveError)}`)
    }
    throw error
  } finally {
    if (page) {
      try {
        await page.evaluate(() => window.remember.pauseCapture({ durationMs: null, sources: ['audio', 'capture'] }))
        const settings = await page.evaluate(() => window.remember.getSettings())
        proof.failureCleanup = {
          pauseRequested: true,
          settings: { capturePaused: settings.capturePaused, audioCaptureEnabled: settings.audioCaptureEnabled },
        }
        assert.equal(settings.capturePaused, true)
        assert.equal(settings.audioCaptureEnabled, false)
      } catch (error) {
        cleanupErrors.push(`pause/readback: ${String(error)}`)
      }
      try {
        await close()
      } catch (error) {
        cleanupErrors.push(`close: ${String(error)}`)
      }
    }
    try {
      for (const filename of [
        'followup-observer-chat.jsonl',
        'followup-expected.json',
        'host-sdk.jsonl',
        'native-wire.jsonl',
      ]) {
        if (existsSync(join(setup.root, filename))) copyFileSync(join(setup.root, filename), join(directory, filename))
      }
      for (const filename of ['proactive-context.jsonl', 'proactive-inference.jsonl']) {
        if (existsSync(join(desktopDirectory, filename)))
          copyFileSync(join(desktopDirectory, filename), join(directory, filename))
      }
    } catch (error) {
      cleanupErrors.push(`log archive: ${String(error)}`)
    }
    if (cleanupErrors.length) {
      proof.cleanupErrors = cleanupErrors
      if (proof.status !== 'failed') {
        proof.status = 'failed'
        proof.error = { message: cleanupErrors.join('; ') }
      }
    }
    try {
      save()
    } catch (error) {
      cleanupErrors.push(`proof archive: ${String(error)}`)
    }
  }
  if (cleanupErrors.length) throw new Error(cleanupErrors.join('; '))
}
