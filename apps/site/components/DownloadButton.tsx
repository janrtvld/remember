import type { ComponentProps } from 'react'
import { Button, DOWNLOAD_URL } from './ui'

type DownloadButtonProps = Omit<ComponentProps<typeof Button>, 'href'>

export function DownloadButton(props: DownloadButtonProps) {
  return <Button {...props} href={DOWNLOAD_URL} />
}
