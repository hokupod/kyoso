export type MessagePhase = "commentary" | "final_answer" | "unknown";

type MessageSegment = {
  id: string;
  phase: MessagePhase;
  retryEpoch: number;
  text: string;
  abandoned: boolean;
  lastChunkSequence: number;
};

type MessageChunk = {
  segment: MessageSegment;
  text: string;
  sequence: number;
};

export type AgentOutputMetrics = {
  observedStreamRetries: number;
  discardedRetryMessageBytes: number;
  firstOutputAt?: string;
  lastAcpUpdateAt?: string;
};

export class AgentOutputAccumulator {
  private readonly segments = new Map<string, MessageSegment>();
  private readonly messageChunks: MessageChunk[] = [];
  private retryEpoch = 0;
  private observedStreamRetries = 0;
  private discardedRetryMessageBytes = 0;
  private firstOutputAt: string | undefined;
  private lastAcpUpdateAt: string | undefined;
  private nextChunkSequence = 0;

  addMessageChunk(
    text: string,
    meta: { messageId?: string; phase?: MessagePhase },
  ): void {
    this.noteOutput();

    const id = meta.messageId ?? `epoch-${this.retryEpoch}`;
    const key = `${this.retryEpoch}\u0000${id}`;
    const phase = meta.phase ?? "unknown";
    let segment = this.segments.get(key);
    if (!segment) {
      segment = {
        id,
        phase,
        retryEpoch: this.retryEpoch,
        text: "",
        abandoned: false,
        lastChunkSequence: 0,
      };
      this.segments.set(key, segment);
    } else if (segment.phase === "unknown" && phase !== "unknown") {
      segment.phase = phase;
    }

    const sequence = this.nextChunkSequence;
    this.nextChunkSequence += 1;
    segment.text += text;
    segment.lastChunkSequence = sequence;
    this.messageChunks.push({ segment, text, sequence });
  }

  addThoughtChunk(_text: string): void {
    this.noteOutput();
  }

  noteUpdate(): void {
    this.lastAcpUpdateAt = new Date().toISOString();
  }

  markRetryBoundary(): { discardedMessageBytes: number } {
    let discardedMessageBytes = 0;
    for (const segment of this.segments.values()) {
      if (segment.retryEpoch !== this.retryEpoch || segment.abandoned) continue;
      segment.abandoned = true;
      discardedMessageBytes += Buffer.byteLength(segment.text, "utf8");
    }

    this.observedStreamRetries += 1;
    this.discardedRetryMessageBytes += discardedMessageBytes;
    this.retryEpoch += 1;
    return { discardedMessageBytes };
  }

  finalRawText(): string {
    if (this.observedStreamRetries === 0) {
      return this.messageChunks.map((chunk) => chunk.text).join("");
    }

    const finalAnswer = [...this.segments.values()]
      .filter(
        (segment) => !segment.abandoned && segment.phase === "final_answer",
      )
      .sort((left, right) => left.lastChunkSequence - right.lastChunkSequence)
      .at(-1);
    if (finalAnswer) return finalAnswer.text;

    return this.messageChunks
      .filter(
        (chunk) =>
          !chunk.segment.abandoned &&
          chunk.segment.retryEpoch === this.retryEpoch &&
          chunk.segment.phase === "unknown",
      )
      .sort((left, right) => left.sequence - right.sequence)
      .map((chunk) => chunk.text)
      .join("");
  }

  metrics(): AgentOutputMetrics {
    return {
      observedStreamRetries: this.observedStreamRetries,
      discardedRetryMessageBytes: this.discardedRetryMessageBytes,
      ...(this.firstOutputAt === undefined
        ? {}
        : { firstOutputAt: this.firstOutputAt }),
      ...(this.lastAcpUpdateAt === undefined
        ? {}
        : { lastAcpUpdateAt: this.lastAcpUpdateAt }),
    };
  }

  private noteOutput(): void {
    const timestamp = new Date().toISOString();
    this.firstOutputAt ??= timestamp;
    this.lastAcpUpdateAt = timestamp;
  }
}
