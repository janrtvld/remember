export const ACCOUNT_DIALOG_EVENT = 'remember:open-account'

export function openAccountDialog(options?: { reconnect?: boolean }) {
  window.dispatchEvent(new CustomEvent(ACCOUNT_DIALOG_EVENT, { detail: options }))
}
