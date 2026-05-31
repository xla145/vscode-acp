/**
 * Configuration for a single ACP agent.
 */
export interface AgentConfigEntry {
  /** Command to run (e.g., "npx") or a full shell inline script when shellInlineScript is true */
  command: string;
  /** Command-line arguments */
  args?: string[];
  /** Environment variables */
  env?: Record<string, string>;
  /** Display name */
  displayName?: string;
  /**
   * When true and args is empty, `command` is passed verbatim to login shell `-c`
   * (no shellEscape). Use for multi-statement nvm/PATH bootstrap scripts.
   */
  shellInlineScript?: boolean;
}

export const FASTOPC_AGENT_NAME = 'FastOPC Agent';

/** Quchi 版 fastopc 需要 Node >= 22.5（node:sqlite）。语句之间用 `;` 分隔。 */
const FASTOPC_ACP_SHELL = [
  'source "$HOME/.nvm/nvm.sh" 2>/dev/null || true',
  'for v in 23.11.1 22.22.3; do',
  'nvm use "$v" >/dev/null 2>&1 && node -e "require(\\"node:sqlite\\")" >/dev/null 2>&1 && break',
  'done',
  'if ! command -v fastopc >/dev/null 2>&1; then',
  'echo "[fastopc-acp] 未找到 fastopc。请用 Node>=22.5 安装: nvm use 23 && npm i -g fastopc --ignore-scripts --registry=..." >&2',
  'exit 127',
  'fi',
  'exec fastopc acp',
].join('; ');

const FASTOPC_AGENT_CONFIG: AgentConfigEntry = {
  command: FASTOPC_ACP_SHELL,
  args: [],
  env: {},
  shellInlineScript: true,
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
