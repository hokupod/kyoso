import type {
  AgentName,
  AgentRole,
  KyosoDecision,
  ModelExecutionIdentity,
  ReviewCompletion,
  ReviewTool,
} from "./types.js";

export type ReviewPhase =
  | "preflight"
  | "context"
  | "snapshot"
  | "primary"
  | "aggregation"
  | "verification"
  | "judge"
  | "finalize";

export type ReviewProgressEvent =
  | {
      type: "review_started";
      traceId: string;
      tool: ReviewTool;
      timestamp: string;
    }
  | {
      type: "phase_started";
      traceId: string;
      phase: ReviewPhase;
      timestamp: string;
    }
  | {
      type: "phase_completed";
      traceId: string;
      phase: ReviewPhase;
      durationMs: number;
      timestamp: string;
    }
  | {
      type: "phase_skipped";
      traceId: string;
      phase: ReviewPhase;
      reason: string;
      timestamp: string;
    }
  | {
      type: "agent_started";
      traceId: string;
      agent: AgentName;
      role: AgentRole;
      executionIdentity?: ModelExecutionIdentity;
      timestamp: string;
    }
  | {
      type: "agent_activity";
      traceId: string;
      agent: AgentName;
      activity: "message" | "thought" | "protocol";
      totalOutputBytes: number;
      timestamp: string;
    }
  | {
      type: "agent_waiting";
      traceId: string;
      agent: AgentName;
      elapsedMs: number;
      sinceLastAcpUpdateMs: number;
      streamIdleTimeoutMs?: number;
      timestamp: string;
    }
  | {
      type: "agent_retrying";
      traceId: string;
      agent: AgentName;
      observedRetry: number;
      attempt?: number;
      maxRetries?: number;
      reason: string;
      discardedMessageBytes: number;
      timestamp: string;
    }
  | {
      type: "agent_completed";
      traceId: string;
      agent: AgentName;
      status: "completed" | "failed" | "timeout" | "skipped";
      durationMs: number;
      outputBytes?: number;
      observedStreamRetries?: number;
      timestamp: string;
    }
  | {
      type: "review_completed";
      traceId: string;
      decision: KyosoDecision;
      completionStatus: ReviewCompletion["status"];
      durationMs: number;
      timestamp: string;
    }
  | {
      type: "review_failed";
      traceId: string;
      errorCode?: string;
      timestamp: string;
    }
  | { type: "review_cancelled"; traceId: string; timestamp: string };

export type ReviewProgressSink = (
  event: ReviewProgressEvent,
) => void | Promise<void>;
