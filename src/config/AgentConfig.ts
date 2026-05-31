/**
 * Configuration for a single ACP agent.
 */
export interface AgentConfigEntry {
  /** Command to run (e.g., "/bin/zsh") */
  command: string;
  /** Command-line arguments */
  args?: string[];
  /** Environment variables */
  env?: Record<string, string>;
  /** Display name */
  displayName?: string;
}

export const FASTOPC_AGENT_NAME = 'FastOPC Agent';

/** Quchi 版 fastopc 需要 Node >= 22.5（node:sqlite）。在 VS Code 子进程中自动选择可用 Node。 */
const FASTOPC_ACP_SHELL = [
  'source "$HOME/.nvm/nvm.sh" 2>/dev/null || true',
  'for v in 23.11.1 22.22.3 22.0.0; do',
  '  nvm use "$v" >/dev/null 2>&1 && node -e "require(\\"node:sqlite\\")" >/dev/null 2>&1 && break',
  'done',
  'if ! command -v fastopc >/dev/null 2>&1; then',
  '  echo "[fastopc-acp] 未找到 fastopc，请先执行: npm install -g fastopc" >&2',
  '  exit 127',
  'fi',
  'exec fastopc acp',
].join(' ');

const FASTOPC_AGENT_CONFIG: AgentConfigEntry = {
  command: '/bin/zsh',
  args: ['-lc', FASTOPC_ACP_SHELL],
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
