import Link from 'next/link'
import { Wordmark } from './Wordmark'

export function Logo({ simplified = false, wordmark = false }: { simplified?: boolean; wordmark?: boolean }) {
  if (wordmark) {
    return <Wordmark />
  }

  if (simplified) {
    return (
      <Link
        href="/"
        aria-label="Ga naar vandaag"
        className="rounded-lg flex bg-white shadow-raised hover:opacity-100 hover:bg-slate-100 opacity-90 size-8 justify-center items-center transition-transform duration-150 ease-out focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-500 active:scale-[0.96]"
      >
        <img src="/logo.svg" alt="" className="size-5" />
      </Link>
    )
  }
  return (
    <Link
      href="/"
      aria-label="Ga naar vandaag"
      className="rounded-xl transition-transform duration-150 ease-out focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-500 active:scale-[0.96]"
    >
      <img src="/logo.svg" alt="" className="size-7 shrink-0" />
    </Link>
  )
}
