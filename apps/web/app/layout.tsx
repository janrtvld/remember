import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import '@internal/styles/globals.css'

export const metadata: Metadata = {
  title: 'Remember',
  description: 'Your local context layer for every workday.',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
