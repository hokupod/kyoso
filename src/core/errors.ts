export class KyosoRequestError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "KyosoRequestError";
  }
}
