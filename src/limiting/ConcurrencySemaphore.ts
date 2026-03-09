export class ConcurrencySemaphore {
  private inFlight = 0;

  public constructor(private readonly maxParallel: number) {}

  public tryAcquire(): boolean {
    if (this.inFlight >= this.maxParallel) {
      return false;
    }

    this.inFlight += 1;
    return true;
  }

  public release(): void {
    if (this.inFlight > 0) {
      this.inFlight -= 1;
    }
  }

  public activeCount(): number {
    return this.inFlight;
  }
}

