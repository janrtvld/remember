import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  type BriefingObservation,
  type BriefingResult,
  hashBriefingValue as hash,
  canonicalBriefingJson as json,
  validateBriefingObservation,
  validateBriefingResult,
} from '../../../../experiments/always-on-agent/briefing-protocol.mjs'
import type { ProactiveDecision } from './dailyReview/proactiveStore'
import {
  type HostInitiativeEnvelopeV2,
  type InitiativePrepared,
  initiativeSourcesWithinScope,
  type StandingGrantScope,
  validateInitiativeEnvelope,
  validateInitiativePrepared,
  validateStandingGrantScope,
} from './hostInitiativeProtocol'

export type StandingGrant = {
  id: string
  generation: number
  scope: StandingGrantScope
  scopeHash: string
  enabled: boolean
  issuedAt: number
  remainingJobs: number
  revokedAt: number | null
}
export type InitiativeAction = {
  envelope: HostInitiativeEnvelopeV2
  envelopeHash: string
  prepared: InitiativePrepared
  preparedHash: string
  grant: StandingGrant
  state: 'prepared' | 'dispatch-intent' | 'cancelled-unsubmitted' | BriefingObservation['phase']
  invalidated: boolean
  observation: BriefingObservation | null
  observationHash: string | null
  cursor: number | null
  terminal: {
    phase: 'completed' | 'stopped'
    hostCreatedAt: number
    hostTerminalAt: number
    completion: BriefingObservation['completion']
    receiptHash: string | null
  } | null
  terminalReceivedAt: number | null
  publication: 'pending' | 'withheld' | 'published'
  result: BriefingResult | null
  resultHash: string | null
}
export type InitiativeAdmissionCurrent = {
  decision: ProactiveDecision
  sourceSequences: { eventId: string; sequence: number }[]
}
type Row = Record<string, unknown>
const decode = <T>(value: unknown): T | null => (value == null ? null : JSON.parse(String(value)))
const changed = (result: { changes: number | bigint }) => {
  if (Number(result.changes) !== 1) throw new Error('initiative-write-not-persisted')
}
const validTime = (now: number) => {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('initiative-clock-invalid')
}

/** Uses Resident's connection. This component never owns or closes a database. */
export class HostInitiativeStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS assistant_standing_grant (
      id TEXT PRIMARY KEY, generation INTEGER NOT NULL, scope_json TEXT NOT NULL, scope_hash TEXT NOT NULL,
      enabled INTEGER NOT NULL, issued_at INTEGER NOT NULL, remaining_jobs INTEGER NOT NULL, revoked_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS assistant_initiative_action (
      action_id TEXT PRIMARY KEY, decision_id TEXT NOT NULL UNIQUE, assistant_message_id TEXT NOT NULL UNIQUE,
      job_id TEXT NOT NULL UNIQUE, grant_id TEXT NOT NULL, grant_generation INTEGER NOT NULL,
      grant_json TEXT NOT NULL, envelope_json TEXT NOT NULL, envelope_hash TEXT NOT NULL,
      prepared_json TEXT NOT NULL, prepared_hash TEXT NOT NULL, state TEXT NOT NULL,
      invalidated INTEGER NOT NULL DEFAULT 0, observation_json TEXT, observation_hash TEXT, cursor INTEGER,
      terminal_json TEXT, terminal_received_at INTEGER, result_json TEXT, result_hash TEXT,
      publication_state TEXT NOT NULL DEFAULT 'pending'
    );`)
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const value = operation()
      this.db.exec('COMMIT')
      return value
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  grant(id: string): StandingGrant | null {
    const row = this.db.prepare('SELECT * FROM assistant_standing_grant WHERE id = ?').get(id)
    return row
      ? {
          id: String(row.id),
          generation: Number(row.generation),
          scope: decode<StandingGrantScope>(row.scope_json)!,
          scopeHash: String(row.scope_hash),
          enabled: Boolean(row.enabled),
          issuedAt: Number(row.issued_at),
          remainingJobs: Number(row.remaining_jobs),
          revokedAt: row.revoked_at == null ? null : Number(row.revoked_at),
        }
      : null
  }

  grants(): StandingGrant[] {
    return this.db
      .prepare('SELECT id FROM assistant_standing_grant ORDER BY rowid')
      .all()
      .map((row) => this.grant(String(row.id))!)
  }

  createGrant(input: unknown, now: number, id: string = randomUUID()): StandingGrant {
    validTime(now)
    const scope = validateStandingGrantScope(input)
    if (!id.trim() || id.length > 200 || scope.expiresAt <= now) throw new Error('initiative-grant-invalid')
    if (scope.version === 2 && scope.expiresAt - now > 30 * 60000) throw new Error('initiative-grant-invalid')
    return this.transaction(() => {
      const previous = this.grant(id)
      if (previous && now < previous.issuedAt) throw new Error('initiative-clock-regression')
      const generation = (previous?.generation ?? 0) + 1
      if (!Number.isSafeInteger(generation)) throw new Error('initiative-grant-invalid')
      if (previous) this.invalidateGrantActions(id, true)
      changed(
        this.db
          .prepare(`INSERT INTO assistant_standing_grant VALUES (?,?,?,?,1,?,?,NULL)
        ON CONFLICT(id) DO UPDATE SET generation=excluded.generation,scope_json=excluded.scope_json,
        scope_hash=excluded.scope_hash,enabled=1,issued_at=excluded.issued_at,remaining_jobs=excluded.remaining_jobs,revoked_at=NULL`)
          .run(id, generation, json(scope), hash(scope), now, scope.maxJobs)
      )
      return this.grant(id)!
    })
  }

  pauseGrant(id: string, generation: number, now: number): StandingGrant {
    return this.disableGrant(id, generation, now, true)
  }

  revokeGrant(id: string, generation: number, now: number): StandingGrant {
    return this.disableGrant(id, generation, now, false)
  }

  private disableGrant(id: string, generation: number, now: number, preservePublished: boolean): StandingGrant {
    validTime(now)
    return this.transaction(() => {
      const grant = this.grant(id)
      if (!grant || grant.generation !== generation) throw new Error('initiative-grant-conflict')
      if (now < grant.issuedAt) throw new Error('initiative-clock-regression')
      changed(
        this.db
          .prepare(
            'UPDATE assistant_standing_grant SET enabled=0,generation=generation+1,revoked_at=? WHERE id=? AND generation=?'
          )
          .run(now, id, generation)
      )
      this.invalidateGrantActions(id, preservePublished)
      return this.grant(id)!
    })
  }

  private invalidateGrantActions(grantId: string, preservePublished = false) {
    const rows = this.db
      .prepare(`SELECT action_id FROM assistant_initiative_action WHERE grant_id=? AND invalidated=0
        ${preservePublished ? "AND NOT (terminal_json IS NOT NULL AND publication_state='published')" : ''}`)
      .all(grantId)
    for (const row of rows)
      changed(
        this.db
          .prepare('UPDATE assistant_initiative_action SET invalidated=1 WHERE action_id=? AND invalidated=0')
          .run(String(row.action_id))
      )
  }

  /** Called inside Resident's existing reset transaction. */
  invalidateAllWithinTransaction(now: number) {
    validTime(now)
    for (const grant of this.grants().filter((g) => g.enabled)) {
      changed(
        this.db
          .prepare(
            'UPDATE assistant_standing_grant SET enabled=0,generation=generation+1,revoked_at=? WHERE id=? AND generation=?'
          )
          .run(now, grant.id, grant.generation)
      )
    }
    for (const row of this.db.prepare('SELECT action_id FROM assistant_initiative_action WHERE invalidated=0').all())
      changed(
        this.db
          .prepare('UPDATE assistant_initiative_action SET invalidated=1 WHERE action_id=? AND invalidated=0')
          .run(String(row.action_id))
      )
  }

  private map(row: Row): InitiativeAction {
    const invalidated = Boolean(row.invalidated)
    return {
      envelope: decode<HostInitiativeEnvelopeV2>(row.envelope_json)!,
      envelopeHash: String(row.envelope_hash),
      prepared: decode<InitiativePrepared>(row.prepared_json)!,
      preparedHash: String(row.prepared_hash),
      grant: decode<StandingGrant>(row.grant_json)!,
      state: row.state as InitiativeAction['state'],
      invalidated,
      observation: decode<BriefingObservation>(row.observation_json),
      observationHash: row.observation_hash == null ? null : String(row.observation_hash),
      cursor: row.cursor == null ? null : Number(row.cursor),
      terminal: decode<InitiativeAction['terminal']>(row.terminal_json),
      terminalReceivedAt: row.terminal_received_at == null ? null : Number(row.terminal_received_at),
      publication: row.publication_state as InitiativeAction['publication'],
      result: invalidated || row.publication_state !== 'published' ? null : decode<BriefingResult>(row.result_json),
      resultHash: row.result_hash == null ? null : String(row.result_hash),
    }
  }

  action(id: string): InitiativeAction | null {
    const row = this.db.prepare('SELECT * FROM assistant_initiative_action WHERE action_id=?').get(id)
    return row ? this.map(row) : null
  }
  forMessage(id: string): InitiativeAction | null {
    const row = this.db.prepare('SELECT * FROM assistant_initiative_action WHERE assistant_message_id=?').get(id)
    return row ? this.map(row) : null
  }
  all(): InitiativeAction[] {
    return this.db
      .prepare('SELECT * FROM assistant_initiative_action ORDER BY rowid')
      .all()
      .map((row) => this.map(row))
  }
  ownsMessage(id: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM assistant_initiative_action WHERE assistant_message_id=?').get(id))
  }
  unresolved(): InitiativeAction[] {
    return this.all().filter(
      (action) => action.state !== 'cancelled-unsubmitted' && !(action.terminal && action.publication === 'published')
    )
  }
  assertTaskIdentityAvailable(input: {
    actionId: string
    jobId: string
    userMessageId: string
    assistantMessageId: string
  }) {
    if (
      this.db
        .prepare(
          'SELECT 1 FROM assistant_initiative_action WHERE action_id=? OR job_id=? OR assistant_message_id IN (?,?)'
        )
        .get(input.actionId, input.jobId, input.userMessageId, input.assistantMessageId)
    )
      throw new Error('initiative-binding-conflict')
  }
  ownsJob(jobId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM assistant_initiative_action WHERE job_id=?').get(jobId))
  }
  assertTaskSlotAvailable() {
    if (
      this.unresolved().length ||
      this.db
        .prepare(
          "SELECT 1 FROM assistant_command WHERE retired_at IS NULL AND state NOT IN ('completed','stopped','cancelled') LIMIT 1"
        )
        .get()
    )
      throw new Error('initiative-effect-slot-occupied')
  }

  assertCommandSlotAvailable() {
    this.assertOtherSlotsAvailable()
  }

  private requireAction(id: string) {
    const action = this.action(id)
    if (!action) throw new Error('initiative-action-missing')
    return action
  }

  private assertOtherSlotsAvailable() {
    this.assertTaskSlotAvailable()
    if (
      this.db
        .prepare(`SELECT 1 FROM assistant_task_run t LEFT JOIN assistant_task_execution e ON e.action_id=t.action_id
      WHERE t.retired_at IS NULL AND COALESCE(e.state,'') != 'cancelled-unsubmitted' AND (t.outcome_json IS NULL OR t.outcome_receipt_json IS NULL) LIMIT 1`)
        .get() ||
      this.db.prepare('SELECT 1 FROM assistant_remote_run LIMIT 1').get() ||
      this.db
        .prepare(
          `SELECT 1 FROM assistant_host_run WHERE retired_at IS NULL AND json_extract(binding,'$.phase') NOT IN ('completed','stopped') LIMIT 1`
        )
        .get()
    )
      throw new Error('initiative-effect-slot-occupied')
  }

  private currentGrant(envelope: HostInitiativeEnvelopeV2, now: number, needBudget: boolean, dispatch = true) {
    const authority = envelope.authority,
      grant = this.grant(authority.grantId)
    if (
      !grant ||
      !grant.enabled ||
      grant.generation !== authority.grantGeneration ||
      grant.scopeHash !== authority.grantScopeHash ||
      grant.scope.expiresAt <= now ||
      (needBudget && grant.remainingJobs < 1)
    )
      throw new Error('initiative-grant-unavailable')
    const scope = grant.scope
    if (now < grant.issuedAt || envelope.startedAt < grant.issuedAt) throw new Error('initiative-clock-regression')
    if (
      json(envelope.target) !== json(scope.target) ||
      envelope.deadlineAt > scope.expiresAt ||
      (dispatch && envelope.deadlineAt <= now) ||
      envelope.capability !== scope.capability ||
      json(envelope.sourceRefs.personal) !== json(scope.personalSources)
    )
      throw new Error('initiative-grant-scope-conflict')
    for (const key of ['model', 'effort', 'maxInputBytes', 'maxOutputBytes', 'maxDurationMs'] as const)
      if (envelope.preparedInput[key] !== scope[key]) throw new Error('initiative-grant-scope-conflict')
    if (!initiativeSourcesWithinScope(scope, envelope.sourceRefs.evidence))
      throw new Error('initiative-source-outside-grant')
    return grant
  }

  admit(input: unknown, preparedInput: unknown, current: InitiativeAdmissionCurrent, now: number): InitiativeAction {
    validTime(now)
    const envelope = validateInitiativeEnvelope(input),
      prepared = validateInitiativePrepared(envelope, preparedInput)
    const envelopeHash = hash(envelope),
      preparedHash = hash(prepared)
    return this.transaction(() => {
      const previous = this.action(envelope.actionId)
      if (previous) {
        if (previous.envelopeHash !== envelopeHash || previous.preparedHash !== preparedHash)
          throw new Error('initiative-binding-conflict')
        return previous
      }
      const decision = current.decision
      const { deliveredMessageId: _message, invalidatedAt: _invalid, ...payload } = decision
      const receipt = this.db
        .prepare(
          `SELECT p.*,m.role,m.text,m.reply_to FROM assistant_proactive_initiative p JOIN assistant_message m ON m.id=p.message_id WHERE p.decision_id=?`
        )
        .get(envelope.authority.decisionId)
      const generation = Number(
        this.db.prepare("SELECT value FROM assistant_state WHERE key='proactive-generation'").get()?.value ?? 0
      )
      if (
        !receipt ||
        receipt.role !== 'assistant' ||
        receipt.reply_to !== null ||
        receipt.message_id !== envelope.assistantMessageId ||
        decision.deliveredMessageId !== envelope.assistantMessageId ||
        decision.id !== envelope.authority.decisionId ||
        decision.kind !== 'prepare' ||
        decision.invalidatedAt !== null ||
        decision.createdAt > now ||
        decision.expiresAt <= now ||
        decision.conversationGeneration !== generation ||
        hash(payload) !== envelope.authority.decisionPayloadHash ||
        receipt.payload_hash !== envelope.authority.decisionPayloadHash ||
        receipt.input_hash !== envelope.authority.decisionInputHash ||
        receipt.payload_json !== json(payload) ||
        receipt.text !== decision.text ||
        envelope.policyFingerprint !== decision.policyToken ||
        envelope.deletionRevision !== decision.deletionRevision ||
        json(decision.sourceRefs) !== json(envelope.sourceRefs.evidence)
      )
        throw new Error('initiative-decision-conflict')
      if (
        this.db
          .prepare(
            'SELECT 1 FROM assistant_proactive_dismissal WHERE topic_key=? AND (expires_at IS NULL OR expires_at>?)'
          )
          .get(decision.topicKey, now)
      )
        throw new Error('initiative-decision-dismissed')
      const grant = this.currentGrant(envelope, now, true)
      if (
        current.sourceSequences.length !== envelope.sourceRefs.evidence.length ||
        envelope.sourceRefs.evidence.some(
          (ref) =>
            current.sourceSequences.filter(
              (s) =>
                s.eventId === ref.eventId && Number.isSafeInteger(s.sequence) && s.sequence > grant.scope.afterSequence
            ).length !== 1
        )
      )
        throw new Error('initiative-source-before-grant')
      this.assertOtherSlotsAvailable()
      if (
        this.db
          .prepare(
            'SELECT 1 FROM assistant_task_run WHERE action_id=? OR job_id=? OR user_message_id=? OR assistant_message_id=?'
          )
          .get(envelope.actionId, envelope.jobId, envelope.assistantMessageId, envelope.assistantMessageId) ||
        this.db
          .prepare('SELECT 1 FROM assistant_host_run WHERE job_id=? OR message_id=?')
          .get(envelope.jobId, envelope.assistantMessageId)
      )
        throw new Error('initiative-binding-conflict')
      changed(
        this.db
          .prepare(
            `INSERT INTO assistant_initiative_action (action_id,decision_id,assistant_message_id,job_id,grant_id,grant_generation,grant_json,envelope_json,envelope_hash,prepared_json,prepared_hash,state) VALUES (?,?,?,?,?,?,?,?,?,?,?,'prepared')`
          )
          .run(
            envelope.actionId,
            decision.id,
            envelope.assistantMessageId,
            envelope.jobId,
            grant.id,
            grant.generation,
            json(grant),
            json(envelope),
            envelopeHash,
            json(prepared),
            preparedHash
          )
      )
      changed(
        this.db
          .prepare(
            'UPDATE assistant_standing_grant SET remaining_jobs=remaining_jobs-1 WHERE id=? AND generation=? AND enabled=1 AND remaining_jobs>0'
          )
          .run(grant.id, grant.generation)
      )
      return this.requireAction(envelope.actionId)
    })
  }

  markDispatch(id: string, preparedHash: string, now: number): boolean {
    validTime(now)
    return this.transaction(() => {
      const action = this.requireAction(id)
      if (action.preparedHash !== preparedHash) throw new Error('initiative-binding-conflict')
      if (action.invalidated) throw new Error('initiative-invalidated')
      if (action.state !== 'prepared') return false
      this.currentGrant(action.envelope, now, false)
      changed(
        this.db
          .prepare(
            "UPDATE assistant_initiative_action SET state='dispatch-intent' WHERE action_id=? AND state='prepared' AND invalidated=0"
          )
          .run(id)
      )
      return true
    })
  }

  cancelUnsubmitted(id: string, preparedHash: string, now: number): InitiativeAction {
    validTime(now)
    return this.transaction(() => {
      const action = this.requireAction(id)
      if (action.preparedHash !== preparedHash) throw new Error('initiative-binding-conflict')
      if (action.state === 'cancelled-unsubmitted') return action
      if (action.state !== 'prepared') throw new Error('initiative-dispatch-already-intended')
      changed(
        this.db
          .prepare(
            "UPDATE assistant_initiative_action SET state='cancelled-unsubmitted',publication_state='published' WHERE action_id=? AND state='prepared'"
          )
          .run(id)
      )
      return this.requireAction(id)
    })
  }

  invalidate(id: string): InitiativeAction {
    return this.transaction(() => {
      this.requireAction(id)
      changed(this.db.prepare('UPDATE assistant_initiative_action SET invalidated=1 WHERE action_id=?').run(id))
      return this.requireAction(id)
    })
  }

  observe(
    id: string,
    input: unknown,
    publication: 'publish' | 'withheld' | 'metadata',
    resultInput: unknown = null,
    now: number
  ): InitiativeAction {
    validTime(now)
    return this.transaction(() => {
      const action = this.requireAction(id)
      const observed = validateBriefingObservation(input, action.prepared.descriptor)
      if (action.state === 'prepared' || action.state === 'cancelled-unsubmitted')
        throw new Error('initiative-observation-before-dispatch')
      if (action.state === 'unknown' && !['unknown', 'stopped'].includes(observed.phase))
        throw new Error('initiative-unknown-no-replay')
      if (action.cursor !== null && observed.cursor < action.cursor) throw new Error('initiative-cursor-regression')
      if (
        action.observation &&
        (observed.createdAt !== action.observation.createdAt || observed.updatedAt < action.observation.updatedAt)
      )
        throw new Error('initiative-host-clock-regression')
      const observationHash = hash({ ...observed, sessionId: null })
      if (observed.cursor === action.cursor && action.observation?.sessionId !== observed.sessionId && !action.terminal)
        throw new Error('initiative-session-conflict')
      if (observed.cursor === action.cursor && action.observationHash !== observationHash)
        throw new Error('initiative-cursor-conflict')
      const terminal =
        observed.phase === 'completed' || observed.phase === 'stopped'
          ? {
              phase: observed.phase,
              hostCreatedAt: observed.createdAt,
              hostTerminalAt: observed.updatedAt,
              completion: observed.completion,
              receiptHash: observed.receipt ? hash(observed.receipt) : null,
            }
          : null
      if (action.terminal && (!terminal || json(terminal) !== json(action.terminal)))
        throw new Error('initiative-terminal-conflict')
      if (now < action.envelope.startedAt || (action.terminalReceivedAt !== null && now < action.terminalReceivedAt))
        throw new Error('initiative-clock-regression')
      let result: BriefingResult | null = null
      if (resultInput !== null) {
        if (publication !== 'publish' || action.invalidated) throw new Error('initiative-private-result-withheld')
        result = validateBriefingResult(resultInput, action.prepared.descriptor)
        if (
          !terminal ||
          terminal.phase !== 'completed' ||
          observed.completion !== 'briefing' ||
          json(result.receipt) !== json(observed.receipt)
        )
          throw new Error('initiative-result-not-completed')
      }
      if (publication === 'publish' && observed.phase === 'completed') {
        if (action.invalidated) throw new Error('initiative-invalidated')
        this.currentGrant(action.envelope, now, false, false)
        if (observed.completion === 'briefing' && !result && !action.result)
          throw new Error('initiative-result-not-verified')
      }
      if (action.resultHash && result && action.resultHash !== hash(result))
        throw new Error('initiative-result-conflict')
      const safeObservation = {
        ...observed,
        events: observed.events.map((event) => ({ ...event, data: { payloadHash: hash(event.data) } })),
        error: observed.error === null ? null : 'host-error',
      }
      const state = observed.phase
      const publishState =
        action.publication === 'published'
          ? 'published'
          : publication === 'withheld'
            ? 'withheld'
            : terminal && publication === 'publish'
              ? 'published'
              : 'pending'
      changed(
        this.db
          .prepare(
            `UPDATE assistant_initiative_action SET state=?,observation_json=?,observation_hash=?,cursor=?,terminal_json=COALESCE(terminal_json,?),terminal_received_at=COALESCE(terminal_received_at,?),result_json=COALESCE(result_json,?),result_hash=COALESCE(result_hash,?),publication_state=? WHERE action_id=?`
          )
          .run(
            state,
            json(safeObservation),
            observationHash,
            observed.cursor,
            terminal ? json(terminal) : null,
            terminal ? now : null,
            result ? json(result) : null,
            result ? hash(result) : null,
            publishState,
            id
          )
      )
      return this.requireAction(id)
    })
  }
}
