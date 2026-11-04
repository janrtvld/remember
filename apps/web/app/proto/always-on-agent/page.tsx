import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { notFound } from 'next/navigation'
import type { Scenario } from './simulation'

export default async function AlwaysOnPrototypePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  if (process.env.NODE_ENV !== 'development') notFound()

  const params = await searchParams
  const scenarios = readFileSync(
    resolve(process.cwd(), '../../tests/fixtures/always-on-benchmarks/v1.scenarios.jsonl'),
    'utf8'
  )
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Scenario)
    .filter((scenario) => ['AO-001', 'AO-006', 'AO-010', 'AO-020'].includes(scenario.id))
  const { Prototype } = await import('./Prototype')
  const variant = Number(params.v)

  return (
    <Prototype
      scenarios={scenarios}
      initialVariant={Number.isInteger(variant) && variant >= 1 && variant <= 3 ? variant - 1 : 0}
    />
  )
}
