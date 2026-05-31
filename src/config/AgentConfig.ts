/**
 * Configuration for a single ACP agent.
 */
export interface AgentConfigEntry {
  /** NPX package to run (e.g., "@anthropic-ai/claude-code@latest") */
  command: string;
  /** Command-line arguments */
  args?: string[];
  /** Environment variables */
  env?: Record<string, string>;
  /** Display name */
  displayName?: string;
}

export const FASTOPC_AGENT_NAME = 'FastOPC Agent';

const FASTOPC_AGENT_CONFIG: AgentConfigEntry = {
  command: '/bin/zsh',
  args: ['-lc', 'source ~/.nvm/nvm.sh && nvm use 23.11.1 >/dev/null && fastopc acp'],
  env: {},
};

export function getAgentConfigs(): Record<string, AgentConfigEntry> {
  return { [FASTOPC_AGENT_NAME]: FASTOPC_AGENT_CONFIG };
}

export function getAgentNames(): string[] {
  return [FASTOPC_AGENT_NAME];
}

export function getAgentConfig(name: string): AgentConfigEntry | undefined {
  return name === FASTOPC_AGENT_NAME ? FASTOPC_AGENT_CONFIG : undefined;
}
