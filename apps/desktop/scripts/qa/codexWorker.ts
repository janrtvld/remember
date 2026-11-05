import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { Page } from 'playwright-core'
import { installAgentConsentFixture } from './agentConsent'

export const longAssistantReviewFixture = Array.from(
  { length: 60 },
  (_, index) => `Synthetic review line ${String(index + 1).padStart(2, '0')}: inspect this bounded QA request.`
).join('\n')

// Only the disposable Electron source copy uses this deterministic server.
// It exercises real transport, IPC, approval UI, persistence and interruption.
export function installCodexWorkerFixture(directory: string) {
  const executable = join(directory, 'codex-worker-fixture.cjs')
  writeFileSync(
    executable,
    `#!${process.execPath}
const readline = require('node:readline');
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
const longReview = ${JSON.stringify(longAssistantReviewFixture)};
let thread = 'qa-codex-thread', turn = '', message = '', streamTimer;
readline.createInterface({input:process.stdin}).on('line', line => {
 const request=JSON.parse(line);
 const reply=result=>send({id:request.id,result});
 const event=(method,params)=>send({method,params:{threadId:thread,...params}});
 if(request.method==='initialize') reply({});
 if(request.method==='thread/start'||request.method==='thread/resume') reply({thread:{id:thread}});
 if(request.method==='turn/start') {
  message=request.params.input[0].text.split('=== Current user request ===\\n').at(-1);turn=message.includes('qa-cancel-no-approval')?'cancel-no-approval':message.includes('qa-cancel')?'cancel':'complete';reply({turn:{id:turn}});
  event('turn/started',{turn:{id:turn}});
  if(message.includes('qa-ux-typing-history')) {
   const text=Array.from({length:60},(_,index)=>'## Workstream '+(index+1)+'\\n\\nThe synthetic client agreed to review the release plan before confirming the launch date. **Owner:** project lead.\\n\\n- Confirm the remaining questions.\\n- Review the acceptance criteria.\\n\\n| Decision | Status |\\n| --- | --- |\\n| Release review | Pending |\\n| Follow-up agenda | Prepared |').join('\\n\\n---\\n\\n');
   event('item/completed',{item:{id:'typing-history',type:'agentMessage',phase:'final_answer',text}});
   event('turn/completed',{turn:{id:turn,status:'completed'}});
   return;
  }
  if(message.includes('qa-ux-short-')) {
   setTimeout(()=>{
    event('item/completed',{item:{id:'ux-answer',type:'agentMessage',phase:'final_answer',text:'Ontvangen.'}});
    event('turn/completed',{turn:{id:turn,status:'completed'}});
   },120);
   return;
  }
  if(turn==='cancel-no-approval') {
   event('item/reasoning/summaryTextDelta',{turnId:turn,itemId:'qa-thinking',delta:'De gevonden notities vergelijken.'});
   let paragraph=0;
   const line=()=> '### Notitie '+(++paragraph)+'\\n\\nDeze synthetische notitie geeft voldoende leesbare context om het scrollanker tijdens een groeiend antwoord te controleren. De tekst blijft behouden na onderbreken.\\n\\n';
   streamTimer=setTimeout(()=>{
    event('item/agentMessage/delta',{turnId:turn,itemId:'qa-stream',delta:Array.from({length:14},line).join('')});
    streamTimer=setInterval(()=>event('item/agentMessage/delta',{turnId:turn,itemId:'qa-stream',delta:line()}),400);
   },6000);
  }
  if(turn!=='cancel-no-approval') send({id:'approval-'+turn,method:'item/commandExecution/requestApproval',params:{threadId:thread,turnId:turn,itemId:'command',command:'printf synthetic-worker-proof',cwd:request.params.cwd||'/tmp',reason:message.includes('qa-assistant-restart')?longReview:'Synthetic QA approval',availableDecisions:['accept','decline']}});
 }
 if(request.id==='approval-complete') {
  if(request.result?.decision!=='accept') process.exit(2);
  event('item/completed',{item:{id:'answer',type:'agentMessage',phase:'final_answer',text:'Synthetic Worker result verified.'}});
  event('turn/completed',{turn:{id:turn,status:'completed'}});
 }
 if(request.method==='turn/interrupt') {clearInterval(streamTimer);reply({});event('turn/completed',{turn:{id:turn,status:'interrupted'}})}
});
`,
    { mode: 0o700 }
  )
  const file = join(directory, 'src/main/agentTurn.ts')
  const source = readFileSync(file, 'utf8')
  const marker = 'findAgentExecutable(input.provider)'
  assert.equal(source.split(marker).length, 2)
  writeFileSync(file, source.replace(marker, JSON.stringify(executable)))
  const worker = join(directory, 'src/main/codexWorker.ts')
  // Do not start real provider MCP helpers in deterministic native QA.
  writeFileSync(worker, readFileSync(worker, 'utf8').replace('installedCodexWorkerTools(options.providerHome)', '{}'))
  installHostResultUiFixture(directory)
  installAgentConsentFixture(directory)
}

// This snapshot overlay tests renderer recovery dispatch, not a real source outage.
// It exists only in the disposable source copy and never changes persisted chat.
function installHostResultUiFixture(directory: string) {
  const file = join(directory, 'src/main/residentAgentRuntime.ts')
  let source = readFileSync(file, 'utf8')
  const replace = (before: string, after: string) => {
    assert.equal(source.split(before).length, 2, `Host result UI fixture marker: ${before}`)
    source = source.replace(before, after)
  }
  replace(
    '  ipcMain.handle(CHANNELS.getAssistantConversation,',
    `  let qaHostResult: (ReturnType<typeof service.snapshot> & {
    qaHostResult: { retryIds: string[]; sendCount: number }
  }) | null = null
  ipcMain.handle(CHANNELS.getAssistantConversation,`
  )
  replace('    return snapshot(beforeMessageId)', '    return qaHostResult ?? snapshot(beforeMessageId)')
  replace(
    '  ipcMain.handle(CHANNELS.sendAssistantMessage, async (event, input: unknown) => {',
    `  ipcMain.handle(CHANNELS.sendAssistantMessage, async (event, input: unknown) => {
    const text = input && typeof input === 'object' && 'text' in input ? input.text : undefined
    if (text === 'qa-host-context-reset') {
      qaHostResult = null
      return service.snapshot()
    }
    if (text === 'qa-host-context-unavailable') {
      const now = Date.now()
      qaHostResult = {
        messages: [
          { id: 'qa-host-result-user', role: 'user', text: 'Synthetic source validation fixture.',
            provider: 'codex', createdAt: now, updatedAt: now, status: 'completed',
            replyTo: null, error: null, steps: [], results: [] },
          { id: 'qa-host-result-message', role: 'assistant', text: 'Previously visible fixture result.',
            provider: 'codex', createdAt: now, updatedAt: now, status: 'completed',
            replyTo: 'qa-host-result-user', error: 'assistant-host-context-unavailable', steps: [], results: [] }
        ],
        activeTurnId: null,
        hasEarlier: false,
        execution: 'remote',
        remoteRecoveryRequired: false,
        remoteRecoveryMessageId: null,
        hostJob: { messageId: 'qa-host-result-message', phase: 'completed', connection: 'disconnected' },
        qaHostResult: { retryIds: [], sendCount: 0 }
      }
      return qaHostResult
    }
    if (qaHostResult) {
      qaHostResult.qaHostResult.sendCount += 1
      throw new Error('qa-unexpected-new-send')
    }
`
  )
  replace(
    '    service.retry(messageId)',
    `    if (qaHostResult) {
      if (messageId !== 'qa-host-result-message') throw new Error('qa-unexpected-host-retry')
      qaHostResult.qaHostResult.retryIds.push(messageId)
      qaHostResult.messages = qaHostResult.messages.map(message => message.id === messageId
        ? { ...message, error: null, text: 'Verified fixture result.' }
        : message)
      return qaHostResult
    }
    service.retry(messageId)`
  )
  writeFileSync(file, source)
}

async function waitFor(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 30_000
  while (!(await check())) {
    assert(Date.now() < deadline, label)
    await delay(100)
  }
}

export async function codexWorkerQa(page: Page, webUrl: string, directory: string) {
  await page.evaluate(() => window.remember.updateSettings({ offlineMode: false }))
  const item = await page.evaluate(() =>
    window.remember.createWorkItem({ title: 'Codex Worker QA', description: 'Synthetic task for native approvals.' })
  )
  const start = async (turnId: string, approval = true) => {
    await page.evaluate(
      async ({ itemId, turnId }) => {
        await window.remember.startWorkItemAgentSession(itemId, {
          sessionId: turnId,
          provider: 'codex',
          prompt: turnId,
          message: turnId,
          startedAt: Date.now(),
        })
        Object.assign(window, { qaWorkerResult: null, qaWorkerStarted: false })
        const unsubscribe = window.remember.onAgentTurnUpdate((update) => {
          if (update.turnId === turnId && update.id === 'codex-started') {
            Object.assign(window, { qaWorkerStarted: true })
          }
        })
        void window.remember
          .runAgentTurn({ turnId, workItemId: itemId, provider: 'codex', prompt: turnId })
          .then(
            (result) => Object.assign(window, { qaWorkerResult: result }),
            (error) => Object.assign(window, { qaWorkerResult: { error: String(error) } })
          )
          .finally(unsubscribe)
      },
      { itemId: item.id, turnId }
    )
    await waitFor(
      () => page.evaluate(() => Reflect.get(window, 'qaWorkerStarted') === true),
      'Worker should start its provider turn'
    )
    if (approval) {
      await waitFor(
        () => page.evaluate(async () => (await window.remember.getAgentInteractions()).length === 1),
        'Worker should request approval'
      )
    }
  }
  await start('qa-approve')
  await page.goto(`${webUrl}/inbox/?item=${encodeURIComponent(item.id)}`)
  await page.getByRole('tab', { name: 'Chat', exact: true }).click()
  await page.getByRole('button', { name: /^(Toestaan|Allow)$/ }).waitFor()
  await page.screenshot({ path: join(directory, 'codex-worker-approval.png') })
  await page.getByRole('button', { name: /^(Toestaan|Allow)$/ }).click()
  await waitFor(
    () =>
      page.evaluate(async () =>
        (await window.remember.listWorkItems()).some(
          (item) =>
            item.title === 'Codex Worker QA' &&
            item.agentSessions.some((session) => session.response === 'Synthetic Worker result verified.')
        )
      ),
    'Worker should persist its result'
  )
  assert.deepEqual(await page.evaluate(() => window.remember.getAgentInteractions()), [])
  // Main-process completion survives losing the originating renderer Promise.
  await page.reload()
  await page.getByRole('tab', { name: 'Chat', exact: true }).click()
  await page.getByText('Synthetic Worker result verified.', { exact: true }).waitFor()
  const composer = page.getByRole('form', { name: /^(Agentgesprek|Agent conversation)$/ })
  await composer.getByRole('button', { name: /^(Verstuur bericht|Send message)$/ }).waitFor()
  assert.equal(await page.getByRole('button', { name: /^(Verder in Codex|Continue in Codex)$/ }).count(), 0)
  assert.equal(await page.getByRole('button', { name: /^(Stoppen|Stop)$/ }).count(), 0)
  await page.screenshot({ path: join(directory, 'codex-worker-completed.png') })
  await start('qa-cancel')
  await composer.getByRole('button', { name: /^(Stoppen|Stop)$/ }).click()
  await waitFor(
    () => page.evaluate(async () => (await window.remember.getAgentInteractions()).length === 0),
    'Stop should clear approvals'
  )
  await waitFor(
    () =>
      page.evaluate(async () =>
        (await window.remember.listWorkItems()).some(
          (item) =>
            item.title === 'Codex Worker QA' &&
            item.agentSessions.some((session) => session.id === 'qa-cancel' && session.status === 'cancelled')
        )
      ),
    'Worker should stop'
  )
  await composer.getByRole('button', { name: /^(Verstuur bericht|Send message)$/ }).waitFor()
  assert.equal(await page.getByRole('button', { name: /^(Stoppen|Stop)$/ }).count(), 0)
  await assert.rejects(
    () => page.evaluate(() => window.remember.cancelAgentTurn('qa-missing')),
    /agent-turn-not-running/
  )
  await start('qa-cancel-no-approval', false)
  assert.deepEqual(await page.evaluate(() => window.remember.getAgentInteractions()), [])
  const runningSession = await page.evaluate(async (itemId) => {
    const item = (await window.remember.listWorkItems()).find((candidate) => candidate.id === itemId)
    return item?.agentSessions.find((session) => session.id === 'qa-cancel-no-approval')
  }, item.id)
  assert.equal(runningSession?.status, 'running')
  assert.equal(runningSession.response, '')
  assert.deepEqual(runningSession.steps, [])
  // Restored runs have no renderer progress or approval request to enable Stop.
  await page.reload()
  await page.getByRole('tab', { name: 'Chat', exact: true }).click()
  await composer.getByRole('button', { name: /^(Stoppen|Stop)$/ }).waitFor()
  await page.screenshot({ path: join(directory, 'codex-worker-running-after-reload.png') })
  await composer.getByRole('button', { name: /^(Stoppen|Stop)$/ }).click()
  await waitFor(
    () =>
      page.evaluate(async (itemId) => {
        const item = (await window.remember.listWorkItems()).find((candidate) => candidate.id === itemId)
        return (
          item?.agentSessions.some(
            (session) => session.id === 'qa-cancel-no-approval' && session.status === 'cancelled'
          ) ?? false
        )
      }, item.id),
    'Restored worker should stop without a pending approval'
  )
  await composer.getByRole('button', { name: /^(Verstuur bericht|Send message)$/ }).waitFor()
  assert.equal(await page.getByRole('button', { name: /^(Stoppen|Stop)$/ }).count(), 0)
  await page.evaluate(() => window.remember.updateSettings({ offlineMode: true }))
  const context = JSON.parse(readFileSync(join(directory, 'profile/inbox-agent-context.json'), 'utf8'))
  assert.equal(context.items[item.id].threads.codex, 'qa-codex-thread')
  writeFileSync(
    join(directory, 'codex-worker-proof.json'),
    JSON.stringify(
      {
        itemId: item.id,
        approval: true,
        resultAfterReload: true,
        cancellation: true,
        cancellationAfterReloadWithoutApproval: true,
        missingTurnRejected: true,
        threadPersisted: true,
      },
      null,
      2
    )
  )
}
