import * as vscode from 'vscode';
import { SessionManager, type QuchiAuthState } from '../core/SessionManager';
import { logAuth } from '../utils/Logger';
import { QuchiDeviceAuth } from './QuchiDeviceAuth';
import { QuchiTokenWatcher } from './QuchiTokenWatcher';

export class QuchiAuthService implements vscode.Disposable {
  private state: QuchiAuthState = { loggedIn: false, pending: false };
  private readonly onDidChangeAuthStateEmitter = new vscode.EventEmitter<QuchiAuthState>();
  readonly onDidChangeAuthState = this.onDidChangeAuthStateEmitter.event;

  private lastStoreSignature: string;
  private readonly tokenWatcher: QuchiTokenWatcher;

  constructor(
    private readonly sessionManager: SessionManager,
    private readonly deviceAuth: QuchiDeviceAuth = new QuchiDeviceAuth(),
  ) {
    this.state = this.deviceAuth.refreshFromStore();
    this.lastStoreSignature = this.deviceAuth.getStoreSignature();
    this.syncSessionManager(this.state);
    this.sessionManager.on('quchi-auth-changed', (state: QuchiAuthState) => {
      this.state = state;
      this.onDidChangeAuthStateEmitter.fire(this.getState());
    });
    this.tokenWatcher = new QuchiTokenWatcher(() => void this.onTokenFileChanged());
  }

  isAuthenticated(): boolean {
    return this.state.loggedIn;
  }

  getState(): QuchiAuthState {
    return { ...this.state };
  }

  async refresh(_agentName?: string): Promise<QuchiAuthState> {
    this.state = this.deviceAuth.refreshFromStore();
    this.lastStoreSignature = this.deviceAuth.getStoreSignature();
    this.syncSessionManager(this.state);
    this.onDidChangeAuthStateEmitter.fire(this.getState());
    return this.getState();
  }

  async signIn(_agentName?: string): Promise<QuchiAuthState> {
    logAuth('QuchiAuthService.signIn');
    this.state = await this.deviceAuth.startDeviceFlow();
    logAuth('QuchiAuthService.signIn done', { userCode: this.state.userCode, pending: this.state.pending });
    this.syncSessionManager(this.state);
    this.onDidChangeAuthStateEmitter.fire(this.getState());
    return this.getState();
  }

  async poll(_agentName: string | undefined, deviceCode: string): Promise<QuchiAuthState> {
    this.state = await this.deviceAuth.pollDeviceFlow(deviceCode);
    this.lastStoreSignature = this.deviceAuth.getStoreSignature();
    this.syncSessionManager(this.state);
    this.onDidChangeAuthStateEmitter.fire(this.getState());
    return this.getState();
  }

  async signOut(): Promise<void> {
    this.deviceAuth.signOut();
    this.lastStoreSignature = this.deviceAuth.getStoreSignature();
    this.sessionManager.clearQuchiAuthState();
    this.state = { loggedIn: false, pending: false };
    this.onDidChangeAuthStateEmitter.fire(this.getState());
  }

  dispose(): void {
    this.tokenWatcher.dispose();
    this.onDidChangeAuthStateEmitter.dispose();
  }

  private async onTokenFileChanged(): Promise<void> {
    const signature = this.deviceAuth.getStoreSignature();
    if (signature === this.lastStoreSignature) {
      return;
    }
    this.lastStoreSignature = signature;

    const next = this.deviceAuth.refreshFromStore();

    // TUI/CLI wrote a token while VS Code was showing device-code UI — adopt logged-in state.
    if (next.loggedIn) {
      this.state = { ...next, pending: false };
    } else {
      this.state = next;
    }

    this.syncSessionManager(this.state);
    this.onDidChangeAuthStateEmitter.fire(this.getState());
  }

  private syncSessionManager(state: QuchiAuthState): void {
    this.sessionManager.syncQuchiAuthState(state);
  }
}
