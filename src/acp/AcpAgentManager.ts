import type { AgentRunInput, AgentRunResult } from "../core/types.js";

export interface AcpAgentManager {
  runAgent(input: AgentRunInput): Promise<AgentRunResult>;
  runAll(inputs: AgentRunInput[]): Promise<AgentRunResult[]>;
}

export abstract class BaseAcpAgentManager implements AcpAgentManager {
  abstract runAgent(input: AgentRunInput): Promise<AgentRunResult>;

  async runAll(inputs: AgentRunInput[]): Promise<AgentRunResult[]> {
    return Promise.all(inputs.map((input) => this.runAgent(input)));
  }
}
