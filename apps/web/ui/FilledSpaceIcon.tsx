'use client'

import type { WikiSpaceIcon } from '@remember/shared'
import { type ReactNode, useId } from 'react'

// Filled adaptations of the normal-state Lucide Animated / Lucide geometry.
// Masked details are transparent rather than painted in a background color.
const shapes: Record<WikiSpaceIcon, { body: ReactNode; detail?: ReactNode }> = {
  lock: {
    body: (
      <>
        <rect x="3" y="11" width="18" height="11" rx="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" fill="none" />
      </>
    ),
    detail: (
      <>
        <circle cx="12" cy="16" r="1" />
        <path d="M12 17v2" />
      </>
    ),
  },
  book: {
    body: <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20" />,
    detail: <path d="M8 7h6M8 11h8M6 17h13M6 20h13" fill="none" />,
  },
  folder: {
    body: <path d="M20 20H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 2h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2Z" />,
    detail: <path d="M3 9h18" />,
  },
  building: {
    body: (
      <>
        <path d="M6 10H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-2v14H6Z" />
        <path d="M6 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16Z" />
      </>
    ),
    detail: <path d="M10 8h4M10 12h4M10 22v-4a2 2 0 0 1 4 0v4" fill="none" />,
  },
  code: { body: <path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18" fill="none" strokeWidth="3" /> },
  bank: {
    body: (
      <>
        <path d="m3 7 9-5 9 5ZM3 22h18M6 18v-7M10 18v-7M14 18v-7M18 18v-7" />
        <path d="M3 19h18" />
      </>
    ),
  },
  heart: {
    body: (
      <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
    ),
  },
  idea: {
    body: (
      <>
        <path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5Z" />
        <path d="M9 18h6M10 22h4" />
      </>
    ),
  },
  people: {
    body: (
      <>
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2Z" />
        <circle cx="9" cy="7" r="4" />
        <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" fill="none" />
      </>
    ),
  },
  rocket: {
    body: (
      <>
        <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
        <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
        <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
      </>
    ),
    detail: <circle cx="16" cy="8" r="1.8" />,
  },
  star: { body: <path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01Z" /> },
  compass: {
    body: <circle cx="12" cy="12" r="10" />,
    detail: <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />,
  },
}

export function FilledSpaceIcon({ icon, className }: { icon: WikiSpaceIcon; className?: string }) {
  const maskId = useId()
  const shape = shapes[icon]
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <defs>
        <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
          <g fill="white" stroke="white" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            {shape.body}
          </g>
          <g fill="black" stroke="black" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            {shape.detail}
          </g>
        </mask>
      </defs>
      <rect width="24" height="24" mask={`url(#${maskId})`} />
    </svg>
  )
}
