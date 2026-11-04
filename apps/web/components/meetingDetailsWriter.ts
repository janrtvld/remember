type Details = { title: string; notes: string }

/** One writer per meeting: newer drafts replace queued drafts, never an active write. */
export class MeetingDetailsWriter {
  private pending: Details | null = null
  private active: Promise<void> | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private generation = 0

  constructor(
    private readonly write: (details: Details) => Promise<unknown>,
    private readonly onError: (failed: boolean) => void
  ) {}

  update(title: string, notes: string) {
    this.pending = { title, notes }
    this.clearTimer()
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush().catch(() => {})
    }, 300)
  }

  cancelPending() {
    this.generation++
    this.pending = null
    this.clearTimer()
  }

  async flush(): Promise<void> {
    this.clearTimer()
    if (this.active) {
      await this.active
      return this.flush()
    }
    const run = async () => {
      while (this.pending) {
        const draft = this.pending
        const generation = this.generation
        this.pending = null
        try {
          await this.write(draft)
          if (generation === this.generation) this.onError(false)
        } catch (error) {
          if (generation !== this.generation) continue
          // A newer full draft can recover a failed older write.
          if (this.pending) continue
          this.pending = draft
          this.onError(true)
          throw error
        }
      }
    }
    this.active = run()
    try {
      await this.active
    } finally {
      this.active = null
    }
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}
