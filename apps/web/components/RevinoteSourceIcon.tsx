import Image from 'next/image'

export function RevinoteSourceIcon() {
  return (
    <Image
      src="/revinote.png"
      alt="Revinote"
      title="Revinote"
      width={14}
      height={14}
      className="size-3.5 shrink-0 rounded-[3px]"
    />
  )
}
