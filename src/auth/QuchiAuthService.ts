import * as vscode from 'vscode';
import { SessionManager, type QuchiAuthState } from '../core/SessionManager';
import { FASTOPC_AGENT_NAME } from '../config/AgentConfig';

export class QuchiAuthService {
  private state: QuchiAuthState = { loggedIn: false, pending: false };
  private readonly onDidChangeAuthStateEmitter = new vscode.EventEmitter<QuchiAuthState>();
  readonly onDidChangeAuthState = this.onDidChangeAuthStateEmitter.event;

  constructor(private readonly sessionManager: SessionManager) {
    this.sessionManager.on('quchi-auth-changed', (state: QuchiAuthState) => {
      this.state = state;
      this.onDidChangeAuthStateEmitter.fire(this.getState());
    });
  }

  isAuthenticated(): boolean {
    return this.state.loggedIn;
  }

  getState(): QuchiAuthState {
    return { ...this.state };
  }

  async refresh(agentName?: string): Promise<QuchiAuthState> {
    const targetAgent = agentName ?? this.getDefaultAgentName();
    this.state = await this.sessionManager.refreshQuchiAuth(targetAgent);
    this.onDidChangeAuthStateEmitter.fire(this.getState());
    return this.getState();
  }

  async signIn(agentName?: string): Promise<QuchiAuthState> {
    const targetAgent = agentName ?? this.getDefaultAgentName();
    this.state = await this.sessionManager.startQuchiAuth(targetAgent);
    this.onDidChangeAuthStateEmitter.fire(this.getState());
    return this.getState();
  }

  async poll(agentName: string | undefined, deviceCode: string): Promise<QuchiAuthState> {
    const targetAgent = agentName ?? this.getDefaultAgentName();
    this.state = await this.sessionManager.pollQuchiAuth(targetAgent, deviceCode);
    this.onDidChangeAuthStateEmitter.fire(this.getState());
    return this.getState();
  }

  async signOut(): Promise<void> {
    this.sessionManager.clearQuchiAuthState();
    this.state = { loggedIn: false, pending: false };
    this.onDidChangeAuthStateEmitter.fire(this.getState());
  }

  private getDefaultAgentName(): string {
    return FASTOPC_AGENT_NAME;
  }
}
