import { buildDayChanges, type Day, type DayChanges, type DaySnapshot } from '@remember/shared'

export function createDaySnapshotPublisher(publish: (changes: DayChanges) => void) {
  let snapshot: DaySnapshot = { revision: 0, days: [] }
  return {
    update(days: Day[]) {
      const changes = buildDayChanges(snapshot, days)
      if (changes) {
        snapshot = { revision: changes.revision, days }
        publish(changes)
      }
      return snapshot
    },
    snapshot: () => snapshot,
  }
}
