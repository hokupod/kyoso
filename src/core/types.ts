export type ReviewTool = "plan_review" | "security_review" | "diff_review";

export type KyosoDecision = "approve" | "approve_with_changes" | "block";

export type GateStatus = "pass" | "warn" | "fail" | "not_applicable";

export type NetworkMode = "model_only" | "unrestricted";

export type JudgeProvider = "auto" | "openai" | "anthropic" | "none";

export type Severity = "critical" | "high" | "medium" | "low" | "info";

export type ReviewLens =
  | "correctness"
  | "regression"
  | "security_boundaries"
  | "secrets_and_injection"
  | "data_integrity"
  | "public_contract"
  | "supply_chain"
  | "privacy"
  | "resource_amplification"
  | "architecture"
  | "performance"
  | "tests"
  | "documentation"
  | "maintainability";

export type ReviewContract = {
  focus?: ReviewLens[];
  nonGoals?: string[];
  acceptedRisks?: Array<{
    findingFingerprint: string;
    rationale: string;
  }>;
};

export type FindingDisposition =
  "gate" | "actionable" | "advisory" | "disputed";

export type ChangeRelation =
  "introduced" | "worsened" | "pre_existing" | "unknown";

export type EvidenceQuality = "concrete" | "partial" | "insufficient";

export type EvidenceRef = {
  kind: "file" | "diff_hunk" | "plan_clause";
  path?: string;
  lineStart?: number;
  lineEnd?: number;
  label?: string;
};

export type ReviewBudget = {
  maxModelCalls: number;
  maxTotalWallTimeMs: number;
  warnAgentOutputBytes: number;
  maxAgentOutputBytes: number;
  maxFindingsPerAgent: number;
  skipOptionalPhasesWhenTokenUsageUnknown: boolean;
};

export type ReviewBudgetRequest = Partial<
  Omit<ReviewBudget, "warnAgentOutputBytes">
>;

export type ResolvedReviewBudget = ReviewBudget & {
  effectiveWarnAgentOutputBytes?: number;
};

export type ReviewCompletionReason =
  | "model_call_budget"
  | "deadline"
  | "agent_output_limit"
  | "token_usage_unknown"
  | "coverage_incomplete"
  | "disputed_finding";

export type ReviewCompletion = {
  status: "complete" | "incomplete";
  reasons: ReviewCompletionReason[];
  retryable: false;
};

export type ModelCallKind = "primary" | "verifier" | "judge";

export type ReviewModelCallPlan = {
  requiredPrimaryCalls: number;
  potentialVerifierCalls: number;
  potentialJudgeCalls: number;
  potentialTotalCalls: number;
  ceilingEffects: Array<{
    kind: ModelCallKind;
    action: "skip" | "deterministic_fallback";
    calls: number;
    reason: "model_call_budget";
  }>;
};

export type ModelTokenUsage = {
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  thoughtTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
};

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
  reviewContract?: ReviewContract;
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
    reviewBudget?: ReviewBudgetRequest;
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
  disposition: FindingDisposition;
  changeRelation: ChangeRelation;
  evidenceQuality: EvidenceQuality;
  evidenceRefs: EvidenceRef[];
  policyReasons: string[];
  fingerprint: string;
  files?: Array<{
    path: string;
    lineStart?: number;
    lineEnd?: number;
  }>;
  sourceAgents: Array<AgentName | "judge" | "kyoso_policy">;
  crossValidation?: "corroborated" | "single_source";
  confidence: "high" | "medium" | "low";
  cisaMapping?: CisaDimension[];
  verification?: {
    status: "confirmed" | "refuted" | "uncertain" | "not_verified";
    verifier?: AgentName;
    note?: string;
  };
};

export type CisaSecureByDesignResult = {
  gateEnabled: boolean;
  enabledDimensions: CisaDimension[];
  customerSecurityOutcomes: GateStatus;
  secureByDefault: GateStatus;
  transparencyAndAccountability: GateStatus;
  governance: GateStatus;
  notes: string[];
};

export type AgentName = "codex" | "claude";

export type AgentRole =
  | "implementation_reviewer"
  | "architecture_security_reviewer"
  | "combined_reviewer"
  | "finding_verifier";

export type ReviewMode = "multi_agent" | "single_agent";

export type ReviewCoverage = {
  requiredLenses: ReviewLens[];
  attemptedLenses: ReviewLens[];
  missingLenses: Array<{ lens: ReviewLens; reason: string }>;
  requiredPerspectives: AgentRole[];
  completedPerspectives: AgentRole[];
  independentReview: boolean;
};

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
    disposition?: FindingDisposition;
    changeRelation?: ChangeRelation;
    evidenceQuality?: EvidenceQuality;
    evidenceRefs?: EvidenceRef[];
    files?: Array<{ path: string; lineStart?: number; lineEnd?: number }>;
    confidence: "high" | "medium" | "low";
    cisaMapping?: string[];
  }>;
  testsToAdd: string[];
  residualRisks: string[];
  openQuestions: string[];
  cisaSecureByDesign?: Partial<CisaSecureByDesignResult>;
};

export type CrossModelAnalysis = {
  blindSpots: string[];
  contradictions: Array<{ topic: string; detail: string }>;
  partialCoverage: Array<{ findingId?: string; note: string }>;
  provider: string;
};

export type AgentRunInput = {
  traceId: string;
  agent: AgentName;
  role: AgentRole;
  tool: ReviewTool;
  prompt: string;
  workspaceDir: string;
  timeoutMs: number;
  deadlineAtEpochMs?: number;
  maxOutputBytes?: number;
  networkMode: NetworkMode;
  // Called once after the agent process has actually started. Preflight failures
  // and spawn failures must not invoke this callback. Managers await a returned
  // promise before settling a started agent result.
  onStarted?: (() => void) | (() => Promise<void>);
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
    detail?: string;
  };
  warnings?: string[];
  usage?: ModelTokenUsage;
  outputBytes?: number;
  stopReason?: string;
  startedAt: string;
  completedAt?: string;
};

export type ReviewExecutionBudget = {
  maxModelCalls: number;
  modelCallPlan: ReviewModelCallPlan;
  modelCalls: {
    planned: number;
    consumed: number;
    skipped: number;
    byKind: Record<
      ModelCallKind,
      { planned: number; consumed: number; skipped: number }
    >;
  };
  wallTime: {
    limitMs: number;
    consumedMs: number;
    remainingMs: number;
  };
  effectiveWarnAgentOutputBytes?: number;
  maxAgentOutputBytes: number;
  maxFindingsPerAgent: number;
  skipOptionalPhasesWhenTokenUsageUnknown: boolean;
  agentOutputBytes: Partial<Record<AgentName, number>>;
  tokenUsage: {
    status: "reported" | "partial" | "unknown";
    reportedCalls: number;
    unknownCalls: number;
    totals: ModelTokenUsage;
  };
};

export type ReviewModelCallAudit = {
  kind: ModelCallKind;
  agent?: AgentName;
  status: "completed" | "skipped";
  reason?: string;
  outputBytes?: number;
  usage?: ModelTokenUsage;
  stopReason?: string;
};

export type KyosoResult = {
  decision: KyosoDecision;
  completion: ReviewCompletion;
  executionBudget: ReviewExecutionBudget;
  requestFingerprint: string;
  degraded: boolean;
  agentsUsed: AgentName[];
  reviewMode: ReviewMode;
  coverage: ReviewCoverage;
  verificationMode?: "cross_agent" | "skipped_single_agent";
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
  crossModelAnalysis?: CrossModelAnalysis;
  testsToAdd: string[];
  residualRisks: string[];
  openQuestions: string[];
  agentOpinions: Array<{
    agent: AgentName;
    role: string;
    summary: string;
    status: "completed" | "failed" | "timeout" | "skipped";
    errorCode?: string;
    rawText?: string;
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
    modelCalls: ReviewModelCallAudit[];
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
