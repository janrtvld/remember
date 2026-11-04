export type BriefingInput = {
  sources: { sourceId: string; revision: string; text: string }[]
}

export type GroundedLine = { text: string; quotes: { sourceId: string; quote: string }[] }
export type BriefingOutput = {
  version: 1
  reason: GroundedLine
} & (
  | { kind: 'silent'; briefing: null }
  | {
      kind: 'private-briefing'
      briefing: {
        title: string
        decision: GroundedLine
        facts: GroundedLine[]
        openPoints: GroundedLine[]
        questions: GroundedLine[]
      }
    }
)

export type BriefingValidation =
  | { valid: true; issues: []; output: BriefingOutput; sourceRefs: { sourceId: string; revision: string }[] }
  | { valid: false; issues: string[]; output: unknown; sourceRefs: [] }

export function validateBriefingOutput(raw: string, input: BriefingInput): BriefingValidation
