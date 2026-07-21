export class KyosoRequestError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "KyosoRequestError";
  }
}

export class KyosoCancellationError extends Error {
  readonly code = "REQUEST_CANCELLED";

  constructor(message = "Kyoso review was cancelled.") {
    super(message);
    this.name = "KyosoCancellationError";
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new KyosoCancellationError(
    typeof signal.reason === "string" ? signal.reason : undefined,
  );
}
