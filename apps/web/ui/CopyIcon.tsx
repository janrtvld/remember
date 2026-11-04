'use client'

import { Check as IconCheckmark1, Copy as IconSquareBehindSquare1 } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useState } from 'react'
import { twMerge } from 'tailwind-merge'
import { IconButton } from './IconButton'

const variants = {
  hidden: { opacity: 0, scale: 0.5, transition: { duration: 0.1 } },
  visible: { opacity: 1, scale: 1, transition: { duration: 0.1 } },
}

export function CopyIcon({
  label,
  ariaLabel,
  value,
  className,
}: {
  label?: string
  ariaLabel?: string
  value: string
  className?: string
}) {
  const [copied, setCopied] = useState(false)

  const copy = () => {
    navigator.clipboard.writeText(value)
    setCopied(true)
    setTimeout(() => {
      setCopied(false)
    }, 1000)
  }

  const animatedIcon = (
    <AnimatePresence mode="wait" initial={false}>
      {copied ? (
        <motion.span key="checkmark" variants={variants} initial="hidden" animate="visible" exit="hidden">
          <IconCheckmark1 className="size-3.5 text-slate-500" />
        </motion.span>
      ) : (
        <motion.span key="copy" variants={variants} initial="hidden" animate="visible" exit="hidden">
          <IconSquareBehindSquare1 className="size-3.5 text-slate-500" />
        </motion.span>
      )}
    </AnimatePresence>
  )

  if (!label) {
    return (
      <IconButton size="compact" aria-label={ariaLabel ?? 'Kopieer'} className={className} onClick={copy}>
        {animatedIcon}
      </IconButton>
    )
  }

  return (
    <button
      type="button"
      aria-label={ariaLabel ?? label}
      className={twMerge(
        'flex w-fit items-center justify-center gap-2 rounded-md border border-slate-300 p-2 text-slate-700 transition-colors hover:border-slate-500',
        className
      )}
      onClick={copy}
    >
      <span className="text-sm">{label}</span>
      {animatedIcon}
    </button>
  )
}
