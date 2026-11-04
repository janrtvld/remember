import type { WikiPageRevision } from '@remember/shared'

export function wikiRevisionActor(revision: WikiPageRevision, t: (key: string) => string) {
  if (revision.actor === 'remember') return t('Remember')
  if (revision.actor === 'user') return t('Jij')
  if (revision.actor === 'external' && revision.sourceId?.startsWith('client:')) {
    return `${revision.sourceId.slice(7)} (client)`
  }
  return revision.actor === 'external' ? t('Extern gewijzigd') : t('Migratie')
}
