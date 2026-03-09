export class SlidingWindowCounter {
  private readonly events: Array<{ timestampMs: number; amount: number }> = [];
  private runningTotal = 0;

  public constructor(private readonly windowMs: number) {}

  /**
   * Remove all events that are outside the rolling window.
   */
  public prune(nowMs: number): void {
    const threshold = nowMs - this.windowMs;

    while (this.events.length > 0 && this.events[0].timestampMs <= threshold) {
      const removed = this.events.shift();
      if (removed) {
        this.runningTotal -= removed.amount;
      }
    }
  }

  /**
   * Return the current sum in the active window.
   */
  public current(nowMs: number): number {
    this.prune(nowMs);
    return this.runningTotal;
  }

  /**
   * Check if adding amount would remain under or equal to maxAllowed.
   */
  public canAdd(nowMs: number, amount: number, maxAllowed: number): boolean {
    const currentValue = this.current(nowMs);
    return currentValue + amount <= maxAllowed;
  }

  /**
   * Record an amount at the current time.
   */
  public add(nowMs: number, amount: number): void {
    this.prune(nowMs);
    this.events.push({ timestampMs: nowMs, amount });
    this.runningTotal += amount;
  }

  /**
   * Small helper to estimate retry delay when we already know we are over limit.
   */
  public retryAfterMs(nowMs: number): number {
    this.prune(nowMs);

    if (this.events.length === 0) {
      return 0;
    }

    const oldest = this.events[0];
    return Math.max(0, oldest.timestampMs + this.windowMs - nowMs);
  }
}

