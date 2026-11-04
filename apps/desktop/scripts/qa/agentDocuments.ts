import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { AssistantConversation, WikiPage } from '@remember/shared'
import type { Page } from 'playwright-core'

const projectTitle = 'China trip QA'
const documentTitle = 'Practical information QA'
const preparation = 'Check current entry requirements before booking.'
const addition = 'Download offline maps before departure.'
const manualAddition = 'Pack a charger.'
const table = '| Preparation | Status |\n| --- | --- |\n| Offline payment backup | To check |'
const createPrompt =
  'qa-agent-documents-create: Create a China trip project in Personal with a practical preparation document.'
const updatePrompt = 'qa-agent-documents-update: Add offline maps to the practical preparation document in Personal.'

/** Replace only executable discovery in the disposable source copy. All tool calls use the production transport. */
export function installAgentDocumentsFixture(directory: string) {
  assert(!directory.endsWith('/apps/desktop'), 'The provider fixture belongs only in a disposable source snapshot')
  const executable = join(directory, 'agent-documents-provider.cjs')
  const log = join(directory, 'agent-documents-provider.jsonl')
  writeFileSync(log, '')
  writeFileSync(
    executable,
    `#!${process.execPath}
const assert=require('node:assert/strict'),fs=require('node:fs'),readline=require('node:readline');
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
const log=value=>fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({at:Date.now(),pid:process.pid,...value})+'\\n');
if(process.argv.includes('--version')){console.log('codex-cli 0.0.0-documents-qa');process.exit(0)}
if(process.argv.includes('login')&&process.argv.includes('status')){console.log('Logged in using ChatGPT');process.exit(0)}
let thread='qa-documents-'+process.pid,turn='qa-documents-turn',sequence=0;
const pending=new Map();
const event=(method,params)=>send({method,params:{threadId:thread,...params}});
const tool=async arguments=>{
 const id='documents-tool-'+(++sequence);log({kind:'tool-request',id,arguments});
 const result=await new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});send({id,method:'item/tool/call',params:{threadId:thread,turnId:turn,callId:id,tool:'remember_memory',arguments}})});
 assert.equal(result.success,true,JSON.stringify(result));const value=JSON.parse(result.contentItems[0].text);log({kind:'tool-result',id,value});return value;
};
const href=page=>'/wiki/page/?space='+encodeURIComponent(page.spaceId)+'&slug='+encodeURIComponent(page.slug);
const complete=text=>{event('item/completed',{item:{id:'documents-answer',type:'agentMessage',phase:'final_answer',text}});event('turn/completed',{turn:{id:turn,status:'completed'}})};
readline.createInterface({input:process.stdin}).on('line',line=>{
 const request=JSON.parse(line);
 if(pending.has(request.id)){const call=pending.get(request.id);pending.delete(request.id);if(request.error)call.reject(Error(JSON.stringify(request.error)));else call.resolve(request.result);return}
 const reply=result=>send({id:request.id,result});
 if(request.method==='initialize')reply({});
 else if(request.method==='thread/start'||request.method==='thread/resume'){
  assert(request.params.dynamicTools.some(tool=>tool.name==='remember_memory'),'Memory capability is exposed through native transport');reply({thread:{id:thread}});
 }else if(request.method==='turn/start'){
  const prompt=request.params.input[0].text.split('=== Current user request ===\\n').at(-1);log({kind:'turn',prompt});reply({turn:{id:turn}});event('turn/started',{turn:{id:turn}});
  setImmediate(()=>{void(async()=>{
   const spaces=await tool({action:'spaces'});const personal=spaces.spaces.find(space=>space.id==='personal');assert(personal);
   if(prompt.includes('qa-agent-documents-create')){
    const initial=await tool({action:'search',spaceId:personal.id,query:'China trip QA'});assert.equal(initial.pages.length,0);
    const project=await tool({action:'create',spaceId:personal.id,category:'projects',title:${JSON.stringify(projectTitle)},content:'## Outline\\n\\n- Destinations: Shenzhen and Shanghai.\\n- Dates and bookings: to be decided.'});assert.equal(project.saved,true);assert(project.slug.startsWith('projects/'));
    const document=await tool({action:'create',spaceId:personal.id,category:'projects',parentSlug:project.slug,title:${JSON.stringify(documentTitle)},content:${JSON.stringify(`${preparation}\n\n${table}`)}});assert.equal(document.saved,true);assert(document.slug.startsWith(project.slug+'/'));
    complete('Created the China trip project and its practical preparation document. [China trip]('+href(project)+') [Practical preparation]('+href(document)+')');
   }else if(prompt.includes('qa-agent-documents-update')){
    const found=await tool({action:'search',spaceId:personal.id,query:${JSON.stringify(documentTitle)}});const target=found.pages.find(page=>page.title===${JSON.stringify(documentTitle)});assert(target);
    const read=await tool({action:'read',spaceId:personal.id,slug:target.slug});assert(read.content.includes(${JSON.stringify(preparation)}));
    const saved=await tool({action:'patch',spaceId:personal.id,slug:read.slug,expectedRevision:read.revision,before:${JSON.stringify(preparation)},after:${JSON.stringify(`${preparation}\n\n${addition}`)},summary:'Add offline maps preparation'});assert.equal(saved.saved,true);
    complete('Added offline maps to [Practical preparation]('+href(saved)+').');
   }else throw Error('Unexpected documents fixture prompt');
  })().catch(error=>{log({kind:'error',error:error.stack});event('turn/completed',{turn:{id:turn,status:'failed',error:{message:error.message}}})})});
 }else if(request.method==='turn/interrupt'){reply({});event('turn/completed',{turn:{id:turn,status:'interrupted'}})}
});
`,
    { mode: 0o700 }
  )
  const turn = join(directory, 'src/main/agentTurn.ts')
  const source = readFileSync(turn, 'utf8')
  const marker = 'findAgentExecutable(input.provider)'
  assert.equal(source.split(marker).length, 2)
  writeFileSync(turn, source.replace(marker, JSON.stringify(executable)))
  const worker = join(directory, 'src/main/codexWorker.ts')
  writeFileSync(worker, readFileSync(worker, 'utf8').replace('installedCodexWorkerTools(options.providerHome)', '{}'))
}

async function waitFor(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 30_000
  while (!(await check())) {
    assert(Date.now() < deadline, label)
    await delay(100)
  }
}

const conversation = (page: Page) => page.evaluate(() => window.remember.getAssistantConversation())
const pages = (page: Page) => page.evaluate(() => window.remember.listWikiPages('personal'))
const pageHref = (slug: string) => `/wiki/page/?space=personal&slug=${encodeURIComponent(slug)}`

async function acceptReview(page: Page, title: string) {
  await waitFor(
    async () =>
      (await page.evaluate(() => window.remember.getAgentInteractions())).some((entry) => entry.detail.includes(title)),
    `The native write review must identify ${title}`
  )
  await page.getByRole('button', { name: /^(Bewaren|Save)$/ }).click()
}

async function send(page: Page, text: string) {
  const composer = page.locator('#assistant-message')
  await composer.fill(text)
  await composer.press('Enter')
  await waitFor(async () => (await composer.inputValue()) === '', 'The Agent accepts the submitted message')
}

async function completed(page: Page, expected: string) {
  await waitFor(async () => {
    const current = await conversation(page)
    return !current.activeTurnId && current.messages.at(-1)?.status === 'completed'
  }, 'The native Agent turn must finish')
  const current = await conversation(page)
  assert(
    current.messages.at(-1)?.text.includes(expected),
    'The Agent must retain the verified answer after source validation'
  )
  return current
}

export async function agentDocumentsQa(page: Page, webUrl: string, directory: string) {
  page.setDefaultNavigationTimeout(120_000)
  await page.evaluate(() => window.remember.updateSettings({ offlineMode: false, cloudAnalysisConsent: true }))
  await page.goto(`${webUrl}/assistant/`)
  await page.locator('#assistant-message').waitFor()
  const original = await pages(page)
  await send(page, createPrompt)
  await waitFor(
    async () =>
      (await page.evaluate(() => window.remember.getAgentInteractions())).some((entry) =>
        entry.detail.includes(projectTitle)
      ),
    'The project write must wait for native review'
  )
  assert.deepEqual(
    (await pages(page)).map((entry) => entry.slug),
    original.map((entry) => entry.slug),
    'Review happens before project creation'
  )
  await page.screenshot({ path: join(directory, 'agent-documents-project-review.png') })
  await acceptReview(page, projectTitle)
  await acceptReview(page, documentTitle)
  const created = await completed(page, 'Created the China trip project')
  const createdPages = await pages(page)
  const project = createdPages.find((entry) => entry.title === projectTitle)
  const document = createdPages.find((entry) => entry.title === documentTitle)
  assert(project && document)
  assert(document.slug.startsWith(`${project.slug}/`))
  assert(document.content.includes(preparation))
  assert(document.content.includes('Offline payment backup'))
  assert.equal(created.messages.at(-1)?.results?.length, 2, 'Both verified creations become saved chat links')
  const link = page.locator(`[data-assistant-reference="document"][href="${pageHref(document.slug)}"]`)
  await link.waitFor()
  assert.equal(await link.count(), 1, 'The saved document link and Markdown reference are deduplicated')
  await page.screenshot({ path: join(directory, 'agent-documents-chat-created.png') })
  const viewport = page.viewportSize()
  await page.setViewportSize({ width: 390, height: 844 })
  assert(await page.evaluate(() => window.document.documentElement.scrollWidth <= innerWidth))
  await page.screenshot({ path: join(directory, 'agent-documents-chat-narrow.png') })
  await link.click()
  await page.getByRole('textbox', { name: /^(Pagina-inhoud|Page content)$/ }).waitFor()
  assert(
    (await page.getByRole('textbox', { name: /^(Pagina-inhoud|Page content)$/ }).textContent())?.includes(preparation)
  )
  assert(await page.evaluate(() => window.document.documentElement.scrollWidth <= innerWidth))
  assert((await page.getByRole('table').textContent())?.includes('Offline payment backup'))
  const editor = page.getByRole('textbox', { name: /^(Pagina-inhoud|Page content)$/ })
  await editor.click()
  await editor.press('ControlOrMeta+a')
  await editor.press('ArrowLeft')
  await editor.pressSequentially(manualAddition)
  await editor.press('Enter')
  await waitFor(async () => {
    const edited = (await pages(page)).find((entry) => entry.slug === document.slug)
    return Boolean(edited?.content.includes(manualAddition) && edited.content.includes('Offline payment backup'))
  }, 'A real editor keystroke must save without dropping the table')
  await page.screenshot({ path: join(directory, 'agent-documents-opened.png') })
  await page.goto(`${webUrl}${pageHref(project.slug)}`)
  await page.getByRole('link', { name: documentTitle, exact: true }).waitFor()
  await page.screenshot({ path: join(directory, 'agent-documents-project.png') })
  if (viewport) await page.setViewportSize(viewport)
  await page.goto(`${webUrl}/assistant/`)
  await page.locator('#assistant-message').waitFor()
  await send(page, updatePrompt)
  await acceptReview(page, document.slug)
  const updated = await completed(page, 'Added offline maps')
  const updatedDocument = (await pages(page)).find((entry) => entry.slug === document.slug)
  assert(updatedDocument)
  assert(updatedDocument.content.includes(addition))
  assert(updatedDocument.content.includes(manualAddition))
  assert(updatedDocument.content.includes('Offline payment backup'))
  assert.notEqual(updatedDocument.revision, document.revision, 'The follow-up creates a new page revision')
  assert.equal(updated.messages.at(-1)?.results?.[0]?.slug, document.slug)
  await page.screenshot({ path: join(directory, 'agent-documents-followup.png') })
  const proof = {
    scope:
      'Real Electron renderer, IPC, native dynamic-tool transport, reviewed Remember memory tools, local wiki/history and chat SQLite; deterministic provider, no live model or capture',
    project,
    document: updatedDocument,
    conversation: updated,
  }
  writeFileSync(join(directory, 'agent-documents-proof.json'), JSON.stringify(proof, null, 2))
}

export async function agentDocumentsAfterRestartQa(page: Page, webUrl: string, directory: string) {
  const proof = JSON.parse(readFileSync(join(directory, 'agent-documents-proof.json'), 'utf8')) as {
    project: WikiPage
    document: WikiPage
    conversation: AssistantConversation
  }
  await page.goto(`${webUrl}/assistant/`)
  await page.locator('#assistant-message').waitFor()
  const current = await conversation(page)
  assert.equal(current.activeTurnId, null)
  assert.equal(current.messages.length, proof.conversation.messages.length)
  assert.deepEqual(current.messages.at(-1)?.results, proof.conversation.messages.at(-1)?.results)
  const document = (await pages(page)).find((entry) => entry.slug === proof.document.slug)
  assert.equal(document?.revision, proof.document.revision)
  assert.equal(document?.content, proof.document.content)
  const result = page.locator(`[data-assistant-message="${current.messages.at(-1)?.id}"]`)
  await result.locator(`[data-assistant-reference="document"][href="${pageHref(proof.document.slug)}"]`).click()
  const content = page.getByRole('textbox', { name: /^(Pagina-inhoud|Page content)$/ })
  await content.waitFor()
  assert((await content.textContent())?.includes(addition))
  assert((await page.getByRole('table').textContent())?.includes('Offline payment backup'))
  const history = await page.evaluate(
    (slug) => window.remember.getWikiPageHistory({ spaceId: 'personal', slug }),
    proof.document.slug
  )
  assert.equal(history.headRevisionId, proof.document.revision)
  assert(history.revisions.length >= 2)
  await page.screenshot({ path: join(directory, 'agent-documents-restarted.png') })
  writeFileSync(
    join(directory, 'agent-documents-restart-proof.json'),
    JSON.stringify({ document, history, conversation: current }, null, 2)
  )
}
