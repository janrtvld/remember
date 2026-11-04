import { Button, type ButtonProps } from '@internal/ui/Button'
import { Spinner } from '@internal/ui/Spinner'

export function SetupButton({ pending = false, children, ...props }: ButtonProps & { pending?: boolean }) {
  return (
    <Button {...props} disabled={pending || props.disabled} aria-busy={pending || props['aria-busy']}>
      <span className={pending ? 'opacity-0' : undefined}>{children}</span>
      {pending ? (
        <span aria-hidden="true" className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <Spinner size="sm" className="text-current" />
        </span>
      ) : null}
    </Button>
  )
}
