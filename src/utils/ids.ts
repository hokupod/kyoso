import { randomUUID } from "node:crypto";

export function newTraceId(): string {
  return `tr_${randomUUID()}`;
}
