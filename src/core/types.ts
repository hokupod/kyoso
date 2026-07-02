export type ReviewTool = "plan_review" | "security_review" | "diff_review";

export type KyosoDecision = "approve" | "approve_with_changes" | "block";

export type GateStatus = "pass" | "warn" | "fail" | "not_applicable";

export type NetworkMode = "model_only" | "unrestricted";

export type JudgeProvider = "auto" | "openai" | "anthropic" | "none";

export type Severity = "critical" | "high" | "medium" | "low" | "info";

export type FindingCategory =
  | "architecture"
  | "authn"
  | "authz"
  | "csrf"
  | "xss"
  | "ssrf"
  | "injection"
  | "secret"
  | "supply_chain"
  | "privacy"
  | "data_loss"
  | "test"
  | "maintainability"
  | "cisa_secure_by_design"
  | "other";

export type CisaDimension =
  | "customer_security_outcomes"
  | "secure_by_default"
  | "transparency_and_accountability"
  | "governance";

export type KyosoReviewRequest = {
  goal: string;
  repoSummary?: string;
  currentPlan?: string;
  selectedFiles?: Array<{
    path: string;
    language?: string;
    content: string;
    truncated?: boolean;
  }>;
  diff?: {
    baseRef?: string;
    headRef?: string;
    unifiedDiff: string;
  };
  constraints?: string[];
  workspace?: {
    root?: string;
    allowRead?: string[];
    denyRead?: string[];
  };
  options?: {
    network?: NetworkMode;
    maxAgentTimeoutMs?: number;
    includeAgentRawOutputs?: boolean;
    judgeProvider?: JudgeProvider;
    allowSecretRedaction?: boolean;
  };
};

export type KyosoFinding = {
  id: string;
  severity: Severity;
  category: FindingCategory;
  title: string;
  evidence: string;
  recommendation: string;
  files?: Array<{
    path: string;
    lineStart?: number;
    lineEnd?: number;
  }>;
  sourceAgents: Array<AgentName | "judge" | "kyoso_policy">;
  confidence: "high" | "medium" | "low";
  cisaMapping?: CisaDimension[];
};

export type CisaSecureByDesignResult = {
  customerSecurityOutcomes: GateStatus;
  secureByDefault: GateStatus;
  transparencyAndAccountability: GateStatus;
  governance: GateStatus;
  notes: string[];
};

export type AgentName = "codex" | "claude";

export type AgentRole =
  | "implementation_reviewer"
  | "architecture_security_reviewer";

export type NormalizedAgentOpinion = {
  agent: AgentName;
  role: string;
  summary: string;
  findings: Array<{
    severity: Severity;
    category: FindingCategory | string;
    title: string;
    evidence: string;
    recommendation: string;
    files?: Array<{ path: string; lineStart?: number; lineEnd?: number }>;
    confidence: "high" | "medium" | "low";
    cisaMapping?: string[];
  }>;
  testsToAdd: string[];
  residualRisks: string[];
  openQuestions: string[];
  cisaSecureByDesign?: Partial<CisaSecureByDesignResult>;
};

export type AgentRunInput = {
  traceId: string;
  agent: AgentName;
  role: AgentRole;
  tool: ReviewTool;
  prompt: string;
  workspaceDir: string;
  timeoutMs: number;
  networkMode: NetworkMode;
};

export type AgentRunResult = {
  agent: AgentName;
  role: AgentRole;
  status: "completed" | "failed" | "timeout" | "skipped";
  rawText?: string;
  normalized?: NormalizedAgentOpinion;
  error?: {
    code: string;
    message: string;
  };
  startedAt: string;
  completedAt?: string;
};

export type KyosoResult = {
  decision: KyosoDecision;
  degraded: boolean;
  summaryMarkdown: string;
  findings: KyosoFinding[];
  cisaSecureByDesign?: CisaSecureByDesignResult;
  disagreements: Array<{
    topic: string;
    positions: Array<{
      agent: AgentName;
      opinion: string;
    }>;
    judgeComment: string;
  }>;
  testsToAdd: string[];
  residualRisks: string[];
  agentOpinions: Array<{
    agent: AgentName;
    role: string;
    summary: string;
    status: "completed" | "failed" | "timeout" | "skipped";
    errorCode?: string;
  }>;
  audit: {
    traceId: string;
    startedAt: string;
    completedAt: string;
    agentsUsed: string[];
    redactionsApplied: number;
    networkMode: NetworkMode;
    workspaceMode: "temp_snapshot";
    configHash?: string;
    warnings?: string[];
  };
};

export type SecretScanResult = {
  detected: boolean;
  redactions: number;
  matches: Array<{
    kind: string;
    location: string;
  }>;
  redactedRequest: KyosoReviewRequest;
};
