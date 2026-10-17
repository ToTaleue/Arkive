/** Report a business failure while retaining any output already produced. */
export class TaskFailure extends Error {
  private readonly resultValue: unknown

  constructor(message: string, result?: unknown) {
    super(message)
    this.name = 'TaskFailure'
    this.resultValue = structuredClone(result)
  }

  get result(): unknown {
    return structuredClone(this.resultValue)
  }
}

/** Report a cancelled business result, including any work already completed. */
export class TaskCancelled extends Error {
  private readonly resultValue: unknown

  constructor(message = '任务已取消。', result?: unknown) {
    super(message)
    this.name = 'TaskCancelled'
    this.resultValue = structuredClone(result)
  }

  get result(): unknown {
    return structuredClone(this.resultValue)
  }
}
