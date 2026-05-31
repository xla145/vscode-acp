import * as vscode from 'vscode';
import { marked } from 'marked';
import { FASTOPC_AGENT_NAME, getAgentConfigs, getAgentNames } from '../config/AgentConfig';
import { QuchiAuthService } from '../auth/QuchiAuthService';
import { SessionManager } from '../core/SessionManager';
import { ChatHistoryStore } from '../core/ChatHistoryStore';
import { SessionUpdateHandler, SessionUpdateListener } from '../handlers/SessionUpdateHandler';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import { logAuth, logError, showAuthLog } from '../utils/Logger';
import { sendEvent } from '../utils/TelemetryManager';
import { HOME_SKILLS, type HomeSkill } from '../skills/homeSkills';

/**
 * WebviewViewProvider for the ACP chat sidebar.
 * Renders chat messages, tool calls, plans, and handles user input.
 */
export class ChatWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'fastopc-chat';

  private view?: vscode.WebviewView;
  private updateListener: SessionUpdateListener;
  private _hasChatContent = false;
  private authRefreshStarted = false;
  private autoConnecting = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly sessionManager: SessionManager,
    private readonly sessionUpdateHandler: SessionUpdateHandler,
    private readonly quchiAuthService: QuchiAuthService,
    private readonly chatHistoryStore?: ChatHistoryStore,
  ) {
    // Configure marked for safe rendering
    marked.setOptions({
      breaks: true,
      gfm: true,
    });

    // Register as a session update listener
    this.updateListener = (update: SessionNotification) => {
      this.handleSessionUpdate(update);
    };
    this.sessionUpdateHandler.addListener(this.updateListener);
  }

  /**
   * Render markdown text to HTML using marked.
   */
  private renderMarkdown(text: string): string {
    try {
      return marked.parse(text) as string;
    } catch {
      return this.escapeHtml(text);
    }
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getHtmlContent(webviewView.webview);

    // Handle messages from the webview
    webviewView.webview.onDidReceiveMessage(async (message) => {
      const msgType = message?.type as string | undefined;
      if (msgType && (msgType.startsWith('quchi') || msgType === 'webviewLog' || msgType === 'ready')) {
        logAuth(`webview → extension: ${msgType}`, msgType === 'quchiPollAuth' ? { deviceCode: !!message.deviceCode } : undefined);
      }
      if (!msgType) {
        logAuth('webview → extension: (no type)', message);
        return;
      }
      switch (msgType) {
        case 'webviewLog':
          logAuth(`[Webview] ${message.message ?? ''}`);
          break;
        case 'sendPrompt':
          this._hasChatContent = true;
          await this.handleSendPrompt(message.text, message.attachments ?? []);
          break;
        case 'cancelTurn':
          await this.handleCancelTurn();
          break;
        case 'setMode':
          await this.handleSetMode(message.modeId);
          break;
        case 'setModel':
          await this.handleSetModel(message.modelId);
          break;
        case 'setConfigOption':
          await this.handleSetConfigOption(message.configId, message.value);
          break;
        case 'executeCommand':
          if (message.command) {
            const args = message.args;
            if (Array.isArray(args)) {
              await vscode.commands.executeCommand(message.command, ...args);
            } else if (args !== undefined) {
              await vscode.commands.executeCommand(message.command, args);
            } else {
              await vscode.commands.executeCommand(message.command);
            }
          }
          break;
        case 'connectAgent':
          await vscode.commands.executeCommand('acp.connectAgent', message.agentName);
          break;
        case 'tabSwitch':
          if (message.agentName && message.sessionId) {
            await vscode.commands.executeCommand('acp.openSession', {
              agentName: message.agentName,
              sessionId: message.sessionId,
            });
          }
          break;
        case 'tabClose':
          if (message.sessionId && this.sessionManager.getActiveSessionId() === message.sessionId) {
            const agent = message.agentName || this.sessionManager.getActiveAgentName();
            if (agent) {
              await this.sessionManager.disconnectAgent(agent);
            }
          }
          break;
        case 'quchiSignIn':
          showAuthLog();
          try {
            await this.handleQuchiSignIn(message.agentName);
          } catch (e: any) {
            logError('Unhandled Quchi sign-in error', e);
            this.postMessage({
              type: 'authError',
              message: e?.message || 'Quchi 登录失败。',
            });
          }
          break;
        case 'quchiPollAuth':
          try {
            await this.handleQuchiPollAuth(message.agentName, message.deviceCode);
          } catch (e: any) {
            logError('Unhandled Quchi poll error', e);
            this.postMessage({
              type: 'authError',
              message: e?.message || 'Quchi 授权轮询失败。',
            });
          }
          break;
        case 'quchiOpenVerificationUri':
          if (message.uri) await vscode.env.openExternal(vscode.Uri.parse(message.uri));
          break;
        case 'quchiCopyUserCode':
          if (message.userCode) await vscode.env.clipboard.writeText(message.userCode);
          break;
        case 'quchiSignOut':
          await this.quchiAuthService.signOut();
          this.sendAuthState();
          break;
        case 'persistMessages':
          // Webview persists chat history for a session to survive VS Code restarts
          if (message.sessionId && Array.isArray(message.messages) && this.chatHistoryStore) {
            this.chatHistoryStore.save(
              message.sessionId,
              message.agentName || '',
              message.messages,
            );
          }
          break;
        case 'ready':
          await this.refreshExistingAuth();
          this.sendCurrentState();
          break;
        case 'renderMarkdown': {
          // Webview requests markdown rendering for history items
          const items: Array<{index: number; text: string}> = message.items || [];
          const rendered = items.map((item: {index: number; text: string}) => ({
            index: item.index,
            html: this.renderMarkdown(item.text),
          }));
          this.postMessage({ type: 'markdownRendered', items: rendered });
          break;
        }
        default:
          if (msgType.startsWith('quchi') || msgType === 'webviewLog') {
            logAuth(`unhandled webview message type: ${msgType}`);
          }
          break;
      }
    });

    const updateSelection = () => this.sendSelectionUpdate();
    const selectionSub = vscode.window.onDidChangeTextEditorSelection(updateSelection);
    const editorSub = vscode.window.onDidChangeActiveTextEditor(updateSelection);
    webviewView.onDidDispose(() => {
      this.view = undefined;
      selectionSub.dispose();
      editorSub.dispose();
    });
    updateSelection();

    // Push auth/UI state even if webview "ready" is delayed or lost (retained context).
    void this.refreshExistingAuth().then(() => {
      this.sendCurrentState();
      this.notifyAuthChanged();
    });
  }

  /** Push active editor selection info to the webview footer. */
  private sendSelectionUpdate(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      this.postMessage({ type: 'selectionUpdate', lines: 0 });
      return;
    }
    const { start, end } = editor.selection;
    const lines = Math.abs(end.line - start.line) + 1;
    this.postMessage({
      type: 'selectionUpdate',
      lines,
      text: editor.document.getText(editor.selection),
    });
  }

  /**
   * Forward session update to webview.
   */
  private handleSessionUpdate(update: SessionNotification): void {
    const updateData = update.update as any;

    // Persist session state BEFORE the active-session check. During session
    // creation the agent can dispatch notifications (e.g.
    // `available_commands_update`) before connectToAgent finishes setting
    // `activeSessionId`. Without this, those updates would be dropped and
    // the slash-command popup would never have commands to show.
    if (updateData?.sessionUpdate === 'available_commands_update') {
      this.sessionManager.applyAvailableCommands(
        update.sessionId,
        updateData.availableCommands || [],
      );
    }
    if (updateData?.sessionUpdate === 'config_option_update') {
      this.sessionManager.applyConfigOptions(
        update.sessionId,
        updateData.configOptions || [],
      );
    }
    if (updateData?.sessionUpdate === 'session_info_update') {
      this.sessionManager.applySessionInfoUpdate(update.sessionId, {
        title: updateData.title,
        updatedAt: updateData.updatedAt,
      });
    }

    // Only forward to the webview if this is the active session — the
    // webview only ever shows one session at a time.
    const activeId = this.sessionManager.getActiveSessionId();
    if (update.sessionId !== activeId) { return; }

    this.postMessage({
      type: 'sessionUpdate',
      update: update.update,
      sessionId: update.sessionId,
    });
  }

  /**
   * Handle a prompt sent from the webview.
   */
  private async handleSendPrompt(
    text: string,
    attachments: Array<{ name: string; path: string }> = [],
  ): Promise<void> {
    const activeId = this.sessionManager.getActiveSessionId();
    if (!activeId) {
      this.postMessage({
        type: 'error',
        message: 'No active session. Create a session first.',
      });
      return;
    }

    sendEvent('chat/messageSent', {
      agentName: this.sessionManager.getActiveAgentName() ?? '',
    }, {
      messageLength: text.length,
    });

    // Record the first prompt for the history store (used as a label
    // fallback when no title is supplied by the agent).
    this.sessionManager.recordFirstPrompt(activeId, text);

    // Tell webview we're processing
    this.postMessage({ type: 'promptStart' });

    try {
      const response = await this.sessionManager.sendPrompt(activeId, text, attachments);
      // Render the accumulated assistant text as markdown
      // The webview will have sent us the raw text via promptEnd handling
      this.postMessage({
        type: 'promptEnd',
        stopReason: response.stopReason,
        usage: (response as any).usage,
      });
      this.sessionManager.touchHistory(activeId);
    } catch (e: any) {
      logError('Prompt failed', e);
      this.postMessage({
        type: 'error',
        message: e.message || 'Prompt failed',
      });
      this.postMessage({ type: 'promptEnd', stopReason: 'error' });
    }
  }

  /**
   * Handle cancel request from webview.
   */
  private async handleCancelTurn(): Promise<void> {
    const activeId = this.sessionManager.getActiveSessionId();
    if (activeId) {
      try {
        await this.sessionManager.cancelTurn(activeId);
      } catch (e) {
        logError('Cancel failed', e);
      }
    }
  }

  /**
   * Handle mode change from webview picker.
   */
  private async handleSetMode(modeId: string): Promise<void> {
    const activeId = this.sessionManager.getActiveSessionId();
    if (!activeId || !modeId) { return; }
    try {
      await this.sessionManager.setMode(activeId, modeId);
    } catch (e: any) {
      logError('Failed to set mode', e);
      this.postMessage({ type: 'error', message: `Failed to set mode: ${e.message}` });
    }
  }

  /**
   * Handle model change from webview picker.
   */
  private async handleSetModel(modelId: string): Promise<void> {
    const activeId = this.sessionManager.getActiveSessionId();
    if (!activeId || !modelId) { return; }
    try {
      await this.sessionManager.setModel(activeId, modelId);
    } catch (e: any) {
      logError('Failed to set model', e);
      this.postMessage({ type: 'error', message: `Failed to set model: ${e.message}` });
    }
  }

  /**
   * Handle generic config-option change from webview picker
   * (ACP "Session Config Options"). The agent returns the full
   * configOptions state which we re-broadcast so any cascading
   * changes are reflected in the UI.
   */
  private async handleSetConfigOption(configId: string, value: string): Promise<void> {
    const activeId = this.sessionManager.getActiveSessionId();
    if (!activeId || !configId) { return; }
    try {
      const options = await this.sessionManager.setConfigOption(activeId, configId, value);
      this.postMessage({ type: 'configOptionsUpdate', configOptions: options });
    } catch (e: any) {
      logError('Failed to set config option', e);
      this.postMessage({ type: 'error', message: `Failed to set ${configId}: ${e.message}` });
      // Roll back optimistic update on the webview by replaying current state
      const session = this.sessionManager.getSession(activeId);
      this.postMessage({
        type: 'configOptionsUpdate',
        configOptions: session?.configOptions ?? null,
      });
    }
  }

  /**
   * Notify webview that auth state changed.
   */
  notifyAuthChanged(): void {
    this.sendAuthState();
  }

  private sendAuthState(): void {
    this.postMessage({
      type: 'authState',
      requireLogin: true,
      loggedIn: this.quchiAuthService.isAuthenticated(),
      authProvider: 'quchi',
      quchi: this.quchiAuthService.getState(),
      autoConnectAgent: FASTOPC_AGENT_NAME,
    });
    void this.maybeAutoConnectFastOpc();
  }

  private async refreshExistingAuth(): Promise<void> {
    if (this.authRefreshStarted || this.quchiAuthService.isAuthenticated()) return;
    this.authRefreshStarted = true;
    try {
      await this.quchiAuthService.refresh(FASTOPC_AGENT_NAME);
      this.sendAuthState();
    } catch (e) {
      logError('Quchi auth refresh failed', e);
    }
  }

  private async maybeAutoConnectFastOpc(): Promise<void> {
    if (!this.quchiAuthService.isAuthenticated()) return;
    if (this.sessionManager.getActiveSessionId()) return;
    if (this.autoConnecting) return;

    this.autoConnecting = true;
    try {
      await this.sessionManager.connectToAgent(FASTOPC_AGENT_NAME);
      this.notifyActiveSessionChanged();
    } catch (e: any) {
      logError('FastOPC auto-connect failed', e);
      this.postMessage({
        type: 'error',
        message: e.message || 'FastOPC Agent 自动连接失败。',
      });
    } finally {
      this.autoConnecting = false;
    }
  }

  private async handleQuchiSignIn(agentName?: string): Promise<void> {
    logAuth('handleQuchiSignIn start', { agentName, hasView: !!this.view });
    try {
      const state = await this.withAuthTimeout(
        this.quchiAuthService.signIn(agentName),
        '获取 Quchi 授权码超时，请检查网络后重试。',
      );
      logAuth('handleQuchiSignIn got state', {
        userCode: state.userCode,
        verificationUri: state.verificationUri,
        pending: state.pending,
      });
      this.sendAuthState();
      this.postMessage({ type: 'quchiAuthState', state });
      logAuth('handleQuchiSignIn posted quchiAuthState to webview');
      if (state.verificationUri) {
        await vscode.env.openExternal(vscode.Uri.parse(state.verificationUri));
        logAuth('handleQuchiSignIn opened browser', { uri: state.verificationUri });
      }
      await this.maybeAutoConnectFastOpc();
    } catch (e: any) {
      logError('Quchi sign-in failed', e);
      this.postMessage({
        type: 'authError',
        message: e.message || 'Quchi 登录失败。',
      });
    }
  }

  private async handleQuchiPollAuth(agentName: string | undefined, deviceCode: string): Promise<void> {
    try {
      const state = await this.withAuthTimeout(
        this.quchiAuthService.poll(agentName, deviceCode),
        'Quchi 授权轮询超时，请重试。',
      );
      this.sendAuthState();
      this.postMessage({ type: 'quchiAuthState', state });
      await this.maybeAutoConnectFastOpc();
    } catch (e: any) {
      logError('Quchi auth polling failed', e);
      this.postMessage({
        type: 'authError',
        message: e.message || 'Quchi 授权轮询失败。',
      });
    }
  }

  /**
   * Send current session state to the webview on load.
   */
  private sendCurrentState(): void {
    const activeId = this.sessionManager.getActiveSessionId();
    const session = activeId ? this.sessionManager.getSession(activeId) : null;
    const activeAgent = this.sessionManager.getActiveAgentName();
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    const agents = getAgentNames().map(name => ({
      name,
      displayName: getAgentConfigs()[name]?.displayName || name,
      connected: this.sessionManager.isAgentConnected(name),
      active: activeAgent === name,
    }));

    const historyStore = this.sessionManager.getHistoryStore();
    const history: Array<{
      agentName: string;
      sessionId: string;
      title: string;
      preview: string;
      lastActiveAt: string;
      isActive: boolean;
    }> = [];
    if (historyStore) {
      for (const agentName of getAgentNames()) {
        for (const entry of historyStore.list(agentName, cwd)) {
          history.push({
            agentName: entry.agentName,
            sessionId: entry.sessionId,
            title: entry.title || entry.firstPrompt || 'Untitled',
            preview: entry.firstPrompt || '',
            lastActiveAt: entry.lastActiveAt,
            isActive: entry.sessionId === activeId,
          });
        }
      }
      history.sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
    }

    this.postMessage({
      type: 'state',
      activeSessionId: activeId,
      platform: process.platform,
      agents,
      history,
      session: session ? {
        sessionId: session.sessionId,
        agentName: session.agentDisplayName,
        title: session.title,
        cwd: session.cwd,
        modes: session.modes,
        models: session.models,
        configOptions: session.configOptions,
        availableCommands: session.availableCommands,
      } : null,
    });
    this.sendAuthState();
  }

  /**
   * Post a message to the webview if it exists.
   */
  private postMessage(message: any): void {
    if (!this.view) {
      logAuth('postMessage skipped: view not ready', { type: message?.type });
      return;
    }
    if (message?.type === 'quchiAuthState' || message?.type === 'authError' || message?.type === 'authState') {
      logAuth(`extension → webview: ${message.type}`);
    }
    void this.view.webview.postMessage(message);
  }

  private withAuthTimeout<T>(promise: Promise<T>, message: string, ms = 45000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), ms);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  /**
   * Notify webview of a new active session.
   */
  notifyActiveSessionChanged(): void {
    this.sendCurrentState();
  }

  /**
   * Notify webview of mode state changes.
   */
  notifyModesUpdate(modes: any): void {
    this.postMessage({ type: 'modesUpdate', modes });
  }

  /**
   * Notify webview of model state changes.
   */
  notifyModelsUpdate(models: any): void {
    this.postMessage({ type: 'modelsUpdate', models });
  }

  /**
   * Notify webview of session config-option state changes.
   */
  notifyConfigOptionsUpdate(configOptions: any): void {
    this.postMessage({ type: 'configOptionsUpdate', configOptions });
  }

  /**
   * Notify webview that a `session/load` replay is starting. The webview
   * wipes any previously-displayed history, disables input, and shows a
   * loading overlay until {@link notifyLoadSessionEnd} fires.
   */
  notifyLoadSessionStart(): void {
    this.postMessage({ type: 'loadSessionStart' });
  }

  /** Notify webview that the active replay finished (success or failure). */
  notifyLoadSessionEnd(ok: boolean): void {
    this.postMessage({ type: 'loadSessionEnd', ok });
  }

  /** Notify webview that session title / metadata changed. */
  notifySessionInfoUpdate(title: string | undefined | null): void {
    this.postMessage({ type: 'sessionInfoUpdate', title: title ?? null });
  }

  /**
   * Restore a session's persisted chat history in the webview and optionally
   * show a specific connected-session context (used when opening historical
   * sessions that the agent cannot load server-side).
   */
  notifyRestoreMessages(
    sessionId: string,
    agentName: string,
    title: string | undefined,
    cwd: string | undefined,
  ): void {
    const messages = this.chatHistoryStore?.load(sessionId) ?? [];
    this.postMessage({
      type: 'restoreMessages',
      sessionId,
      agentName,
      title: title ?? null,
      cwd: cwd ?? null,
      messages,
    });
  }

  /**
   * Clear the chat history and reset to welcome state.
   * Called when starting a new conversation.
   */
  clearChat(): void {
    this._hasChatContent = false;
    this.postMessage({ type: 'clearChat' });
  }

  /**
   * Whether the chat has any messages.
   */
  get hasChatContent(): boolean {
    return this._hasChatContent;
  }

  private getHomeSkills(): HomeSkill[] {
    const configured = vscode.workspace.getConfiguration('acp').get<HomeSkill[]>('skills', []);
    return configured.length > 0 ? configured : HOME_SKILLS;
  }

  /**
   * Generate the HTML content for the webview.
   */
  private getHtmlContent(webview: vscode.Webview): string {
    const nonce = getNonce();
    const homeSkillsJson = JSON.stringify(this.getHomeSkills());

    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>ACP Chat</title>
  <style>
    :root {
      --container-padding: 12px;
      --message-radius: 10px;
      --composer-radius: 14px;
      --input-radius: 14px;
      --tab-h: 34px;
      --hdr-h: 40px;

      /* Theme-aware tokens (follow VS Code color theme) */
      --accent: var(--vscode-focusBorder, var(--vscode-textLink-foreground, var(--vscode-button-background, #007acc)));
      --accent-blue: var(--vscode-textLink-foreground, var(--vscode-charts-blue, var(--accent)));
      --accent-send: var(--vscode-button-background, var(--accent));
      --accent-on: var(--vscode-button-foreground, var(--vscode-editor-foreground));

      --composer-bg: var(--vscode-input-background, var(--vscode-sideBar-background));
      --composer-border: var(--vscode-input-border, var(--vscode-panel-border));
      --composer-muted: var(--vscode-input-placeholderForeground, var(--vscode-descriptionForeground));
      --composer-chip-bg: var(--vscode-button-secondaryBackground, var(--vscode-input-background));
      --composer-chip-border: var(--vscode-button-border, var(--vscode-input-border, var(--vscode-panel-border)));
      --composer-chip-fg: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
      --composer-shadow: color-mix(in srgb, var(--vscode-widget-shadow, var(--vscode-foreground)) 16%, transparent);
      --composer-dropdown-bg: var(--vscode-dropdown-background, var(--vscode-editorWidget-background));
      --composer-dropdown-border: var(--vscode-dropdown-border, var(--vscode-panel-border));
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }

    /* ── Header ─────────────────────────────────────────────────── */
    .app-header {
      flex-shrink: 0;
      height: var(--hdr-h);
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 0 8px 0 12px;
      background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .header-logo {
      font-size: 0.7em;
      font-weight: 700;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      opacity: 0.7;
      flex-shrink: 0;
      margin-right: 2px;
    }
    .header-spacer { flex: 1; }
    .icon-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      border: none;
      border-radius: 6px;
      background: transparent;
      color: var(--vscode-foreground);
      cursor: pointer;
      opacity: 0.65;
      font-size: 14px;
      padding: 0;
      flex-shrink: 0;
    }
    .icon-btn:hover { background: var(--vscode-toolbar-hoverBackground); opacity: 1; }
    .icon-btn:disabled { opacity: 0.3; cursor: not-allowed; }
    .icon-btn svg { width: 16px; height: 16px; fill: currentColor; }
    /* New-agent button gets accent treatment */
    .icon-btn.new-agent-btn {
      opacity: 1;
      color: var(--accent);
      font-size: 20px;
      font-weight: 300;
      background: color-mix(in srgb, var(--accent) 12%, transparent);
    }
    .icon-btn.new-agent-btn:hover {
      background: color-mix(in srgb, var(--accent) 24%, transparent);
    }
    /* Avatar / login button */
    .avatar-btn {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      border: none;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 10px;
      font-weight: 700;
      flex-shrink: 0;
      background: linear-gradient(135deg, var(--accent), var(--accent-blue));
      color: var(--accent-on);
      opacity: 0.9;
    }
    .avatar-btn:hover { opacity: 1; }
    /* History badge dot */
    .hdr-badge-wrap { position: relative; }
    .hdr-badge-wrap .badge-dot {
      position: absolute;
      top: 4px; right: 4px;
      width: 6px; height: 6px;
      border-radius: 50%;
      background: var(--vscode-testing-iconPassed);
      border: 1.5px solid var(--vscode-sideBar-background);
      display: none;
    }
    .hdr-badge-wrap.has-history .badge-dot { display: block; }

    /* ── Tab bar ─────────────────────────────────────────────────── */
    .tab-bar {
      flex-shrink: 0;
      height: var(--tab-h);
      display: flex;
      align-items: stretch;
      overflow-x: auto;
      scrollbar-width: none;
      background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .tab-bar::-webkit-scrollbar { display: none; }
    .tab-bar:empty { display: none; }
    .tab {
      flex-shrink: 0;
      display: flex;
      align-items: center;
      gap: 5px;
      padding: 0 10px;
      min-width: 80px;
      max-width: 160px;
      border-right: 1px solid var(--vscode-panel-border);
      font-size: 0.82em;
      color: var(--vscode-tab-inactiveForeground, var(--vscode-foreground));
      cursor: pointer;
      position: relative;
      user-select: none;
      white-space: nowrap;
      overflow: hidden;
      opacity: 0.7;
    }
    .tab:hover { opacity: 1; background: var(--vscode-tab-hoverBackground, var(--vscode-toolbar-hoverBackground)); }
    .tab.active {
      opacity: 1;
      color: var(--vscode-tab-activeForeground, var(--vscode-foreground));
      background: var(--vscode-tab-activeBackground, var(--vscode-editor-background));
    }
    .tab.active::after {
      content: '';
      position: absolute;
      bottom: 0; left: 0; right: 0;
      height: 2px;
      background: var(--accent);
    }
    .tab-dot {
      width: 7px; height: 7px;
      border-radius: 50%;
      flex-shrink: 0;
      background: var(--vscode-testing-iconPassed);
    }
    .tab-dot.idle { background: var(--vscode-foreground); opacity: 0.3; }
    .tab-dot.warn { background: var(--vscode-statusBarItem-warningBackground, #fab387); }
    .tab-title {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .tab-close {
      flex-shrink: 0;
      width: 16px; height: 16px;
      display: flex; align-items: center; justify-content: center;
      opacity: 0;
      border-radius: 3px;
      font-size: 11px;
      color: var(--vscode-foreground);
      transition: opacity 0.1s;
    }
    .tab:hover .tab-close { opacity: 0.6; }
    .tab-close:hover { opacity: 1 !important; background: var(--vscode-toolbar-hoverBackground); }

    /* ── Connected banner ────────────────────────────────────────── */
    .session-banner {
      display: none;
      flex-shrink: 0;
      align-items: center;
      gap: 7px;
      padding: 5px var(--container-padding);
      background: color-mix(in srgb, var(--vscode-testing-iconPassed) 7%, transparent);
      border-bottom: 1px solid color-mix(in srgb, var(--vscode-testing-iconPassed) 20%, transparent);
      font-size: 0.82em;
    }
    .session-banner.visible { display: flex; }
    .session-banner .dot {
      width: 7px; height: 7px;
      border-radius: 50%;
      background: var(--vscode-testing-iconPassed);
      flex-shrink: 0;
      animation: pulse-dot 2.5s ease-in-out infinite;
    }
    @keyframes pulse-dot { 0%,100%{opacity:1} 50%{opacity:0.45} }
    .session-banner .agent {
      font-weight: 600;
      color: var(--vscode-testing-iconPassed);
    }
    .session-banner .connected-label {
      opacity: 0.55;
      font-size: 0.95em;
    }
    .session-banner .sep { opacity: 0.35; }
    .session-banner .cwd {
      opacity: 0.55;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
      min-width: 0;
      direction: rtl;
      text-align: left;
    }

    /* ── Messages area ───────────────────────────────────────────── */
    .messages {
      flex: 1;
      overflow-y: auto;
      padding: var(--container-padding);
      display: flex;
      flex-direction: column;
      gap: 8px;
      scrollbar-width: thin;
      scrollbar-color: var(--vscode-panel-border) transparent;
    }

    .message {
      padding: 9px 13px;
      border-radius: var(--message-radius);
      max-width: 95%;
      line-height: 1.55;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .message.user {
      align-self: flex-end;
      background: var(--vscode-input-background, var(--vscode-button-secondaryBackground));
      color: var(--vscode-foreground);
      border: 1px solid var(--vscode-panel-border);
      border-radius: var(--message-radius) var(--message-radius) 3px var(--message-radius);
    }
    .message.user .attachment-pill {
      display: inline-flex; align-items: center; gap: 5px;
      background: color-mix(in srgb, var(--vscode-foreground) 8%, transparent);
      border-radius: 4px;
      padding: 2px 7px;
      font-size: 0.82em;
      margin-top: 6px;
      color: var(--vscode-descriptionForeground, var(--vscode-foreground));
      opacity: 0.85;
    }
    .message.user .attachment-pill::before { content: '📎'; font-size: 11px; }
    .message.assistant {
      align-self: flex-start;
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 3px var(--message-radius) var(--message-radius) var(--message-radius);
    }
    /* Markdown body inside assistant messages */
    .message.assistant.md-rendered { white-space: normal; }
    .message.assistant.md-rendered p { margin: 0 0 0.5em; }
    .message.assistant.md-rendered p:last-child { margin-bottom: 0; }
    .message.assistant.md-rendered pre {
      background: var(--vscode-textCodeBlock-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 9px 12px;
      overflow-x: auto;
      margin: 0.5em 0;
      font-family: var(--vscode-editor-font-family);
      font-size: 0.9em;
      line-height: 1.4;
    }
    .message.assistant.md-rendered code {
      font-family: var(--vscode-editor-font-family);
      font-size: 0.9em;
      background: var(--vscode-textCodeBlock-background);
      padding: 1px 4px;
      border-radius: 3px;
    }
    .message.assistant.md-rendered pre code { background: none; padding: 0; border-radius: 0; }
    .message.assistant.md-rendered ul,
    .message.assistant.md-rendered ol { margin: 0.4em 0; padding-left: 1.5em; }
    .message.assistant.md-rendered li { margin: 0.15em 0; }
    .message.assistant.md-rendered h1,
    .message.assistant.md-rendered h2,
    .message.assistant.md-rendered h3,
    .message.assistant.md-rendered h4 { margin: 0.6em 0 0.3em; font-weight: 600; }
    .message.assistant.md-rendered h1 { font-size: 1.3em; }
    .message.assistant.md-rendered h2 { font-size: 1.15em; }
    .message.assistant.md-rendered h3 { font-size: 1.05em; }
    .message.assistant.md-rendered blockquote {
      border-left: 3px solid var(--vscode-focusBorder);
      margin: 0.4em 0; padding: 0.2em 0 0.2em 0.8em; opacity: 0.85;
    }
    .message.assistant.md-rendered a { color: var(--vscode-textLink-foreground); text-decoration: none; }
    .message.assistant.md-rendered a:hover { text-decoration: underline; }
    .message.assistant.md-rendered table { border-collapse: collapse; margin: 0.4em 0; font-size: 0.9em; }
    .message.assistant.md-rendered th,
    .message.assistant.md-rendered td { border: 1px solid var(--vscode-panel-border); padding: 4px 8px; }
    .message.assistant.md-rendered th { background: var(--vscode-editorWidget-background); font-weight: 600; }
    .message.assistant.md-rendered hr { border: none; border-top: 1px solid var(--vscode-panel-border); margin: 0.6em 0; }

    /* Thought block */
    .thought-block {
      width: 100%; margin-bottom: 4px;
      background: color-mix(in srgb, var(--accent-blue) 5%, transparent);
      border: 1px solid color-mix(in srgb, var(--accent-blue) 18%, transparent);
      border-radius: 6px;
      overflow: hidden;
    }
    .thought-block summary {
      font-size: 0.81em;
      cursor: pointer;
      padding: 6px 10px;
      user-select: none;
      display: flex;
      align-items: center;
      gap: 7px;
      list-style: none;
      color: var(--accent-blue);
    }
    .thought-block summary::-webkit-details-marker { display: none; }
    .thought-block summary::before { content: '▾'; font-size: 0.88em; flex-shrink: 0; }
    .thought-block:not([open]) summary::before { content: '▸'; }
    .thought-block summary .th-label { font-weight: 500; flex: 1; }
    .thought-block summary .th-time {
      opacity: 0.7; font-size: 0.9em;
      color: var(--vscode-foreground);
    }
    .thought-block.streaming summary .thought-indicator {
      display: inline-block;
      width: 6px; height: 6px;
      border-radius: 50%;
      background: var(--accent-blue);
      animation: thoughtPulse 1.2s ease-in-out infinite;
      flex-shrink: 0;
    }
    @keyframes thoughtPulse { 0%,100%{opacity:0.4} 50%{opacity:1} }
    .thought-block .thought-content {
      padding: 8px 12px 10px;
      border-top: 1px solid color-mix(in srgb, var(--accent-blue) 12%, transparent);
      font-size: 0.85em;
      opacity: 0.82;
      font-style: italic;
      line-height: 1.55;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 300px;
      overflow-y: auto;
    }

    .message.error {
      align-self: center;
      background: color-mix(in srgb, var(--vscode-inputValidation-errorBackground, #f38ba8) 40%, transparent);
      color: var(--vscode-inputValidation-errorForeground, #f38ba8);
      border: 1px solid color-mix(in srgb, var(--vscode-inputValidation-errorBorder, #f38ba8) 35%, transparent);
      border-radius: 6px;
      padding: 7px 12px;
      font-size: 0.84em;
      text-align: center;
    }

    /* Streaming cursor */
    .cursor-blink {
      display: inline-block;
      width: 2px; height: 13px;
      background: var(--accent);
      animation: blink-cursor 1s step-end infinite;
      vertical-align: text-bottom;
      margin-left: 1px;
      border-radius: 1px;
    }
    @keyframes blink-cursor { 0%,100%{opacity:1} 50%{opacity:0} }

    /* Turn container */
    .turn { display: flex; flex-direction: column; gap: 4px; align-self: flex-start; max-width: 95%; }
    .turn-agent-label {
      display: flex; align-items: center; gap: 5px;
      font-size: 0.75em; opacity: 0.65; margin-bottom: 2px;
      user-select: none;
    }
    .turn-agent-label .al-dot {
      width: 6px; height: 6px; border-radius: 50%;
      background: var(--accent); flex-shrink: 0;
    }

    /* Tool calls group */
    .turn-tools {
      display: flex; flex-direction: column; gap: 2px;
      padding-left: 10px;
      border-left: 2px solid var(--vscode-panel-border);
      margin: 2px 0;
    }
    .turn-tools-summary { font-size: 0.8em; opacity: 0.6; cursor: pointer; padding: 2px 0; user-select: none; }
    .turn-tools-summary:hover { opacity: 0.9; }
    .turn-tools-list { }
    .turn-tools-list.collapsed { display: none; }

    /* Tool call row (flat, per mockup) */
    .tool-row {
      display: flex; flex-wrap: wrap; align-items: center; row-gap: 3px; column-gap: 8px;
      padding: 5px 10px;
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      font-size: 0.82em;
    }
    .tool-row .tr-icon { font-size: 13px; flex-shrink: 0; }
    .tool-row .tr-name { flex: 1; color: var(--vscode-descriptionForeground, var(--vscode-foreground)); opacity: 0.85; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
    .tool-row .tr-name em { color: var(--vscode-foreground); font-style: normal; font-weight: 500; }
    .tool-row .tr-status {
      font-size: 0.76em;
      padding: 1px 6px;
      border-radius: 3px;
      font-weight: 500;
      flex-shrink: 0;
    }
    .tool-row .tr-status.pending { background: color-mix(in srgb, var(--vscode-foreground) 10%, transparent); opacity: 0.6; }
    .tool-row .tr-status.running { background: color-mix(in srgb, var(--accent-blue) 15%, transparent); color: var(--accent-blue); }
    .tool-row .tr-status.completed { background: color-mix(in srgb, var(--vscode-testing-iconPassed) 12%, transparent); color: var(--vscode-testing-iconPassed); }
    .tool-row .tr-status.failed { background: color-mix(in srgb, var(--vscode-testing-iconFailed) 12%, transparent); color: var(--vscode-testing-iconFailed); }

    /* Tool locations chips */
    .tr-locations { display: flex; flex-wrap: wrap; gap: 4px; width: 100%; }
    .tr-loc { font-size: 0.75em; opacity: 0.65; background: color-mix(in srgb,var(--vscode-foreground) 8%,transparent); border-radius: 3px; padding: 1px 5px; font-family: var(--vscode-editor-font-family,monospace); max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: default; }

    /* Tool content body (expandable) */
    .tr-body { width: 100%; }
    .tr-body-toggle { font-size: 0.72em; cursor: pointer; opacity: 0.5; user-select: none; display: inline-block; }
    .tr-body-toggle:hover { opacity: 0.85; }
    .tr-body-content { display: none; margin-top: 4px; }
    .tr-body-content.open { display: block; }

    /* Diff rendering */
    .tr-diff { border: 1px solid var(--vscode-panel-border); border-radius: 4px; overflow: hidden; margin-bottom: 4px; }
    .tr-diff-path { font-family: var(--vscode-editor-font-family,monospace); font-size: 0.8em; padding: 2px 8px; background: color-mix(in srgb,var(--vscode-foreground) 8%,transparent); opacity: 0.75; }
    .tr-diff-lines { max-height: 180px; overflow-y: auto; font-family: var(--vscode-editor-font-family,monospace); font-size: 0.8em; line-height: 1.45; }
    .tr-diff-line { display: flex; min-width: 0; }
    .tr-diff-line span { padding: 0 8px; white-space: pre; word-break: break-all; min-width: 0; }
    .tr-diff-line.add { background: color-mix(in srgb,var(--vscode-testing-iconPassed) 12%,transparent); color: var(--vscode-testing-iconPassed); }
    .tr-diff-line.del { background: color-mix(in srgb,var(--vscode-testing-iconFailed) 12%,transparent); color: var(--vscode-testing-iconFailed); }
    .tr-diff-line.ctx { opacity: 0.5; }

    /* Text / terminal output */
    .tr-text-out { font-size: 0.8em; font-family: var(--vscode-editor-font-family,monospace); max-height: 120px; overflow-y: auto; padding: 4px 6px; background: color-mix(in srgb,var(--vscode-foreground) 5%,transparent); border-radius: 3px; white-space: pre-wrap; word-break: break-word; margin-bottom: 4px; }

    /* Legacy inline tool (history restore) */
    .tool-call-inline {
      display: flex; align-items: center; gap: 8px;
      padding: 5px 10px;
      font-size: 0.82em;
      border-radius: 5px;
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-panel-border);
      opacity: 0.9;
    }
    .tool-call-inline .tc-icon { flex-shrink: 0; font-size: 13px; }
    .tool-call-inline .tc-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tool-call-inline .tc-status {
      font-size: 0.76em;
      padding: 1px 6px;
      border-radius: 3px;
      font-weight: 500;
      flex-shrink: 0;
      white-space: nowrap;
    }
    .tool-call-inline .tc-status.pending {
      background: color-mix(in srgb, var(--vscode-foreground) 10%, transparent);
      opacity: 0.6;
    }
    .tool-call-inline .tc-status.running {
      background: color-mix(in srgb, var(--accent-blue) 15%, transparent);
      color: var(--accent-blue);
    }
    .tool-call-inline .tc-status.completed {
      background: color-mix(in srgb, var(--vscode-testing-iconPassed) 12%, transparent);
      color: var(--vscode-testing-iconPassed);
    }
    .tool-call-inline .tc-status.failed {
      background: color-mix(in srgb, var(--vscode-testing-iconFailed) 12%, transparent);
      color: var(--vscode-testing-iconFailed);
    }

    /* Legacy standalone tool-call card */
    .tool-call {
      padding: 8px 12px; border-radius: var(--message-radius);
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-panel-border); font-size: 0.9em;
    }
    .tool-call .title { font-weight: 600; margin-bottom: 4px; }
    .tool-call .status-badge {
      display: inline-block; padding: 1px 6px; border-radius: 3px;
      font-size: 0.8em; margin-left: 6px;
    }
    .tool-call .status-badge.pending { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
    .tool-call .status-badge.running { background: var(--vscode-progressBar-background); color: white; }
    .tool-call .status-badge.completed { background: var(--vscode-testing-iconPassed); color: white; }
    .tool-call .status-badge.failed { background: var(--vscode-testing-iconFailed); color: white; }

    /* Plan */
    .plan {
      padding: 8px 12px; border-radius: var(--message-radius);
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-panel-border);
    }
    .plan .plan-title { font-weight: 600; margin-bottom: 6px; }
    .plan .plan-entry { padding: 2px 0; display: flex; align-items: center; gap: 6px; }
    .plan .plan-entry.completed { text-decoration: line-through; opacity: 0.6; }

    /* ── Home / empty state ─────────────────────────────────────── */
    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: stretch;
      justify-content: flex-start;
      flex: 1;
      min-height: min-content;
      text-align: left;
      padding: 16px 8px 24px;
      position: relative;
      z-index: 1;
    }
    .home-screen {
      width: 100%;
      max-width: 340px;
      margin: 0 auto;
      display: flex;
      flex-direction: column;
      gap: 0;
    }
    .home-brand {
      padding: 4px 6px 16px;
    }
    .home-logo {
      width: 42px;
      height: 42px;
      border-radius: 11px;
      background: color-mix(in srgb, var(--accent) 14%, var(--vscode-editorWidget-background));
      border: 1px solid color-mix(in srgb, var(--accent) 22%, var(--vscode-panel-border));
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 22px;
      margin-bottom: 12px;
    }
    .home-title {
      font-size: 1.12em;
      font-weight: 700;
      letter-spacing: -0.01em;
      margin-bottom: 4px;
    }
    .home-subtitle {
      font-size: 0.82em;
      color: var(--composer-muted);
      line-height: 1.5;
    }
    .home-menu {
      display: flex;
      flex-direction: column;
      gap: 3px;
      margin-bottom: 22px;
    }
    .home-menu-item {
      display: flex;
      align-items: center;
      gap: 11px;
      width: 100%;
      padding: 9px 12px;
      border: none;
      border-radius: 10px;
      background: transparent;
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      font-size: 0.88em;
      font-weight: 500;
      cursor: pointer;
      text-align: left;
      transition: background 0.12s, color 0.12s;
    }
    .home-menu-item:hover {
      background: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--vscode-foreground) 6%, transparent));
    }
    .home-menu-item.active {
      background: var(--vscode-list-activeSelectionBackground, color-mix(in srgb, var(--accent) 20%, transparent));
      color: var(--vscode-list-activeSelectionForeground, var(--vscode-foreground));
    }
    .home-menu-item .hmi-icon {
      width: 20px;
      height: 20px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      opacity: 0.9;
    }
    .home-menu-item .hmi-icon svg {
      width: 17px;
      height: 17px;
      stroke: currentColor;
      fill: none;
      stroke-width: 1.65;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .home-menu-item .hmi-label { flex: 1; min-width: 0; }
    .home-section {
      padding-top: 4px;
      border-top: 1px solid var(--vscode-panel-border);
    }
    .home-section-title {
      font-size: 0.72em;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.07em;
      color: var(--composer-muted);
      margin: 14px 0 8px;
      padding: 0 6px;
    }
    .agent-cards {
      width: 100%;
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 0 2px;
    }
    .agent-card {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 12px;
      border-radius: 10px;
      cursor: pointer;
      text-align: left;
      border: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editorWidget-background, var(--composer-bg));
      transition: border-color 0.12s, background 0.12s, box-shadow 0.12s;
    }
    .agent-card:hover {
      border-color: var(--vscode-focusBorder);
      background: var(--vscode-list-hoverBackground, var(--vscode-editorWidget-background));
    }
    .agent-card.connected {
      background: color-mix(in srgb, var(--accent) 10%, var(--vscode-editorWidget-background));
      border-color: color-mix(in srgb, var(--accent) 32%, var(--vscode-panel-border));
    }
    .agent-card.add-card {
      border-style: dashed;
      color: var(--composer-muted);
      background: transparent;
    }
    .agent-card.add-card:hover { color: var(--vscode-foreground); }
    .agent-card .ac-icon { font-size: 18px; flex-shrink: 0; width: 24px; text-align: center; }
    .agent-card .ac-info { flex: 1; min-width: 0; }
    .agent-card .ac-name { font-size: 0.88em; font-weight: 600; }
    .agent-card .ac-desc {
      font-size: 0.76em;
      color: var(--composer-muted);
      margin-top: 2px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .agent-card .ac-status {
      font-size: 0.72em;
      flex-shrink: 0;
      white-space: nowrap;
    }
    .agent-card .ac-status.on { color: var(--vscode-testing-iconPassed); }
    .agent-card .ac-status.off { color: var(--composer-muted); }
    .empty-icon, .empty-title, .empty-hint { display: none; }
    .empty-connect-btn { display: none; }
    .chat-brand, .empty-mascot { display: none; }
    .empty-state .actions { display: none; }

    /* ── Session home (skill shortcuts after connecting) ── */
    .session-home {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      padding: 20px 8px 16px;
      gap: 10px;
    }
    .session-home-title {
      font-size: 0.72em;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.07em;
      color: var(--composer-muted);
      padding: 0 4px;
    }
    .session-home-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 7px;
    }
    .skill-chip {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 5px 12px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 20px;
      background: var(--vscode-editorWidget-background);
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      font-size: 0.83em;
      font-weight: 500;
      cursor: pointer;
      transition: border-color 0.12s, background 0.12s;
      text-align: left;
    }
    .skill-chip:hover {
      border-color: color-mix(in srgb, var(--accent) 70%, var(--vscode-panel-border));
      background: color-mix(in srgb, var(--accent) 8%, var(--vscode-editorWidget-background));
    }
    .skill-chip .sc-slash {
      font-size: 0.78em;
      font-family: var(--vscode-editor-font-family, monospace);
      opacity: 0.45;
      white-space: nowrap;
    }

    /* ── Composer (design: single lavender-bordered card) ── */
    .input-area {
      position: relative;
      display: flex;
      flex-direction: column;
      background: var(--vscode-sideBar-background);
      flex-shrink: 0;
      min-width: 0;
      padding: 10px 12px 12px;
    }
    .input-area.disabled { opacity: 0.45; pointer-events: none; }

    .slash-popup {
      display: none;
      position: absolute;
      bottom: 100%;
      left: 12px;
      right: 12px;
      max-height: 200px;
      overflow-y: auto;
      background: var(--vscode-editorSuggestWidget-background, var(--vscode-dropdown-background));
      border: 1px solid var(--vscode-editorSuggestWidget-border, var(--vscode-dropdown-border));
      border-radius: 10px;
      box-shadow: 0 -4px 16px var(--composer-shadow);
      z-index: 200;
      margin-bottom: 6px;
    }
    .slash-popup.open { display: block; }
    .slash-popup-header {
      padding: 6px 10px 4px; font-size: 0.78em;
      opacity: 0.5; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;
    }
    .slash-popup-item { padding: 6px 10px; cursor: pointer; display: flex; align-items: baseline; gap: 8px; }
    .slash-popup-item:hover, .slash-popup-item.active { background: var(--vscode-list-hoverBackground); }
    .slash-popup-item .cmd-name {
      font-weight: 600; color: var(--vscode-textLink-foreground);
      white-space: nowrap; font-family: var(--vscode-editor-font-family);
    }
    .slash-popup-item .cmd-desc { font-size: 0.9em; opacity: 0.7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }

    .input-card {
      background: var(--composer-bg);
      border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--composer-border));
      border-radius: var(--composer-radius);
      display: flex;
      flex-direction: column;
      overflow: visible;
      min-width: 0;
      container-type: inline-size;
      container-name: composer;
      box-shadow: 0 1px 2px var(--composer-shadow);
    }
    .input-card:focus-within {
      border-color: var(--vscode-focusBorder, color-mix(in srgb, var(--accent) 55%, var(--composer-border)));
      box-shadow: 0 0 0 1px color-mix(in srgb, var(--vscode-focusBorder, var(--accent)) 25%, transparent);
    }

    .attach-pills {
      display: none;
      flex-wrap: wrap;
      gap: 5px;
      padding: 10px 14px 0;
    }
    .attach-pills.has-pills { display: flex; }
    .attach-pill {
      display: inline-flex; align-items: center; gap: 5px;
      background: color-mix(in srgb, var(--vscode-foreground) 6%, transparent);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 5px;
      padding: 2px 7px;
      font-size: 0.78em;
      opacity: 0.85;
    }
    .attach-pill .pill-icon { font-size: 11px; opacity: 0.7; }
    .attach-pill .pill-name { max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .attach-pill .pill-remove {
      cursor: pointer; font-size: 11px; opacity: 0.5; margin-left: 2px;
    }
    .attach-pill .pill-remove:hover { opacity: 1; color: var(--vscode-testing-iconFailed); }

    .input-card textarea {
      width: 100%;
      resize: none;
      background: transparent;
      color: var(--vscode-input-foreground, var(--vscode-foreground));
      border: none;
      padding: 14px 14px 6px;
      font-family: var(--vscode-font-family);
      font-size: 0.92em;
      line-height: 1.5;
      min-height: 48px;
      max-height: 160px;
      outline: none;
    }
    .input-card textarea::placeholder {
      color: var(--composer-muted);
      opacity: 1;
    }

    /* Toolbar row — inside card, bottom */
    .input-footer {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 6px;
      padding: 4px 8px 10px;
      flex-shrink: 0;
      min-height: 38px;
      min-width: 0;
      overflow: visible;
    }
    .footer-left {
      display: flex;
      align-items: center;
      gap: 4px;
      flex: 0 1 auto;
      min-width: 0;
      max-width: 55%;
    }
    .footer-right {
      display: flex;
      align-items: center;
      gap: 6px;
      flex: 1 1 140px;
      min-width: 0;
      max-width: 100%;
      justify-content: flex-end;
    }
    .footer-controls {
      display: flex;
      align-items: center;
      gap: 4px;
      flex: 1 1 auto;
      min-width: 0;
      overflow: visible;
      justify-content: flex-end;
    }

    .toolbar-mini {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      border: none;
      border-radius: 4px;
      background: transparent;
      color: var(--composer-muted);
      cursor: pointer;
      opacity: 0.85;
      padding: 0;
      flex-shrink: 0;
    }
    .toolbar-mini:hover {
      opacity: 1;
      color: var(--vscode-foreground);
      background: var(--vscode-toolbar-hoverBackground, color-mix(in srgb, var(--vscode-foreground) 8%, transparent));
    }
    .toolbar-mini svg { width: 14px; height: 14px; fill: currentColor; }

    .selection-badge {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-size: 0.78em;
      color: var(--composer-muted);
      opacity: 1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
      padding-left: 2px;
    }
    .selection-badge.hidden { display: none; }
    .selection-badge svg { width: 13px; height: 13px; flex-shrink: 0; opacity: 0.75; }

    .mode-label { display: none !important; }

    .send-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      flex: 0 0 32px;
      background: var(--accent-send);
      color: var(--accent-on);
      transition: filter 0.12s, opacity 0.12s;
    }
    .send-btn:hover:not(:disabled) {
      background: var(--vscode-button-hoverBackground, var(--accent-send));
      filter: brightness(1.04);
    }
    .send-btn:disabled { opacity: 0.45; cursor: not-allowed; }
    .send-btn.stop {
      background: color-mix(in srgb, var(--vscode-inputValidation-errorBackground, var(--vscode-errorForeground)) 22%, transparent);
      color: var(--vscode-inputValidation-errorForeground, var(--vscode-errorForeground));
      border: 1px solid color-mix(in srgb, var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground)) 35%, transparent);
    }
    .send-btn svg { width: 15px; height: 15px; }

    .picker-wrap {
      position: relative;
      flex: 1 1 0;
      min-width: 0;
      max-width: 120px;
      overflow: visible;
    }
    .picker-wrap.dropdown-open {
      z-index: 200;
    }
    .picker-wrap.hidden { display: none; }

    .picker-btn {
      display: flex;
      align-items: center;
      gap: 4px;
      height: 28px;
      width: 100%;
      max-width: 100%;
      padding: 0 8px;
      border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--composer-chip-border));
      border-radius: 14px;
      background: var(--composer-chip-bg);
      color: var(--composer-chip-fg);
      font-family: var(--vscode-font-family);
      font-size: 0.76em;
      font-weight: 500;
      cursor: pointer;
      white-space: nowrap;
      min-width: 0;
      overflow: hidden;
    }
    .picker-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground, color-mix(in srgb, var(--accent) 12%, var(--composer-chip-bg)));
      border-color: color-mix(in srgb, var(--accent) 45%, var(--composer-chip-border));
    }
    .picker-btn .picker-icon { flex-shrink: 0; font-size: 12px; line-height: 1; }
    .picker-btn .picker-label {
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
      flex: 1;
      opacity: 1;
    }
    .picker-btn .picker-chevron {
      flex-shrink: 0;
      font-size: 8px;
      opacity: 0.75;
      margin-left: -2px;
    }

    .picker-dropdown {
      display: none;
      position: absolute;
      bottom: calc(100% + 8px);
      left: 0;
      min-width: 260px;
      max-width: min(320px, calc(100vw - 24px));
      max-height: 280px;
      overflow-y: auto;
      background: var(--composer-dropdown-bg);
      color: var(--vscode-dropdown-foreground, var(--vscode-foreground));
      border: 1px solid var(--composer-dropdown-border);
      border-radius: 10px;
      box-shadow: 0 8px 24px var(--composer-shadow);
      z-index: 150;
      padding: 4px;
    }
    .picker-dropdown.open {
      display: block;
      z-index: 250;
    }
    .picker-dropdown-item {
      padding: 8px 10px;
      cursor: pointer;
      display: flex;
      align-items: flex-start;
      gap: 9px;
      font-size: calc(var(--vscode-font-size) - 1px);
      color: var(--vscode-foreground);
      border-radius: 7px;
    }
    .picker-dropdown-item:hover { background: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--vscode-foreground) 6%, transparent)); }
    .picker-dropdown-item.selected {
      background: var(--vscode-list-activeSelectionBackground, color-mix(in srgb, var(--accent) 14%, transparent));
      color: var(--vscode-list-activeSelectionForeground, var(--vscode-foreground));
    }
    .picker-dropdown-item .check {
      width: 14px;
      text-align: center;
      flex-shrink: 0;
      margin-top: 2px;
      opacity: 0.9;
    }
    .picker-dropdown-item .mo-icon { font-size: 14px; flex-shrink: 0; margin-top: 1px; }
    .picker-dropdown-item .item-body { flex: 1; min-width: 0; }
    .picker-dropdown-item .item-label { font-weight: 600; font-size: 0.88em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .picker-dropdown-item .item-desc {
      font-size: 0.76em;
      color: var(--composer-muted);
      opacity: 1;
      margin-top: 3px;
      white-space: normal;
      line-height: 1.4;
    }

    /* Rich popover tooltip (gear + title + check + description) */
    .picker-tooltip {
      position: fixed;
      display: none;
      max-width: 280px;
      min-width: 240px;
      padding: 0;
      background: var(--composer-dropdown-bg);
      color: var(--vscode-foreground);
      border: 1px solid var(--composer-dropdown-border);
      border-radius: 10px;
      font-size: calc(var(--vscode-font-size) - 1px);
      line-height: 1.4;
      white-space: normal;
      word-break: break-word;
      box-shadow: 0 8px 24px var(--composer-shadow);
      pointer-events: none;
      z-index: 300;
      overflow: hidden;
    }
    .picker-tooltip.visible { display: block; }
    .picker-tooltip .pt-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px 8px;
      font-weight: 600;
      font-size: 0.92em;
    }
    .picker-tooltip .pt-header .pt-gear { opacity: 0.7; font-size: 13px; }
    .picker-tooltip .pt-header .pt-title { flex: 1; }
    .picker-tooltip .pt-header .pt-check { opacity: 0.85; font-size: 13px; }
    .picker-tooltip .pt-body {
      padding: 0 12px 11px;
      font-size: 0.82em;
      color: var(--composer-muted);
      opacity: 1;
      line-height: 1.45;
    }

    .picker-dropdown-group-header {
      padding: 6px 10px 2px;
      font-size: 0.72em;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      opacity: 0.5;
      pointer-events: none;
    }
    .picker-dropdown-group-header:not(:first-child) {
      border-top: 1px solid var(--vscode-panel-border);
      margin-top: 4px;
    }
    .picker-row { display: flex; align-items: center; gap: 4px; min-width: 0; flex: 0 1 auto; overflow: visible; }
    .picker-row:empty { display: none; }
    .picker-row .picker-wrap { flex: 0 1 auto; max-width: 100px; }

    /* Composer responsive — sidebar narrow widths */
    @container composer (max-width: 360px) {
      .footer-left { max-width: 42%; }
      .picker-wrap { max-width: 100px; }
    }
    @container composer (max-width: 300px) {
      .input-footer { row-gap: 8px; }
      .footer-left { max-width: 100%; flex: 1 1 100%; }
      .footer-right { flex: 1 1 100%; width: 100%; }
      .selection-badge { max-width: calc(100% - 30px); }
    }
    @container composer (max-width: 240px) {
      .picker-btn .picker-label,
      .picker-btn .picker-chevron { display: none; }
      .picker-btn {
        width: 28px;
        padding: 0;
        justify-content: center;
      }
      .picker-wrap {
        flex: 0 0 28px;
        max-width: 28px;
        min-width: 28px;
      }
    }

    /* Spinner */
    .spinner {
      display: inline-block; width: 14px; height: 14px;
      border: 2px solid var(--vscode-foreground); border-top-color: transparent;
      border-radius: 50%; animation: spin 0.8s linear infinite; opacity: 0.6;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* Session load overlay */
    .load-overlay {
      display: none; position: fixed; inset: 0;
      align-items: center; justify-content: center;
      flex-direction: column; gap: 10px;
      background: color-mix(in srgb, var(--vscode-sideBar-background) 88%, transparent);
      backdrop-filter: blur(2px); z-index: 400;
      font-size: 0.9em; color: var(--vscode-foreground); pointer-events: all;
    }
    .load-overlay.visible { display: flex; }
    .load-overlay .spinner { width: 22px; height: 22px; border-width: 3px; opacity: 0.9; }
    .load-overlay .label { opacity: 0.85; }

    /* History slide-in panel */
    .history-backdrop {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.45);
      z-index: 18;
    }
    .history-backdrop.open { display: block; }
    .history-panel {
      display: none;
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: var(--vscode-sideBar-background);
      z-index: 20;
      flex-direction: column;
    }
    .history-panel.open { display: flex; }
    .history-header {
      display: flex; align-items: center; gap: 8px;
      padding: 12px 14px;
      border-bottom: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
    }
    .history-header h3 { flex: 1; font-size: 0.95em; font-weight: 600; }
    .history-close {
      width: 26px; height: 26px;
      background: transparent; border: none;
      color: var(--vscode-descriptionForeground, var(--vscode-foreground));
      border-radius: 6px; cursor: pointer; font-size: 16px;
      display: flex; align-items: center; justify-content: center;
    }
    .history-close:hover { background: var(--vscode-toolbar-hoverBackground); }
    .history-search {
      padding: 10px 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
    }
    .history-search input {
      width: 100%;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 6px;
      color: var(--vscode-input-foreground);
      padding: 7px 10px;
      font-size: 0.85em;
      outline: none;
      font-family: var(--vscode-font-family);
    }
    .history-search input:focus { border-color: var(--vscode-focusBorder); }
    .history-list {
      flex: 1; overflow-y: auto; padding: 8px;
      display: flex; flex-direction: column; gap: 2px;
    }
    .history-group-label {
      font-size: 0.72em;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--vscode-descriptionForeground, var(--vscode-foreground));
      opacity: 0.55;
      padding: 6px 8px 4px;
      font-weight: 600;
    }
    .history-item {
      display: flex; flex-direction: column; gap: 2px;
      padding: 8px 10px;
      border-radius: 6px;
      cursor: pointer;
    }
    .history-item:hover { background: var(--vscode-list-hoverBackground); }
    .history-item.active { background: color-mix(in srgb, var(--accent) 10%, transparent); }
    .hi-top { display: flex; align-items: center; gap: 7px; }
    .hi-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; background: var(--accent-blue); }
    .hi-title { flex: 1; font-size: 0.87em; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .hi-time { font-size: 0.75em; opacity: 0.5; flex-shrink: 0; }
    .hi-preview { font-size: 0.78em; opacity: 0.5; padding-left: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .history-empty {
      padding: 24px 16px;
      text-align: center;
      font-size: 0.85em;
      opacity: 0.5;
    }

    /* ── Quchi login gate ── */
    .login-gate {
      display: none;
      position: fixed;
      inset: 0;
      z-index: 500;
      background: var(--vscode-sideBar-background);
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 28px 24px;
      overflow-y: auto;
    }
    .login-gate.visible { display: flex; }
    .login-screen {
      width: 100%;
      max-width: 300px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 24px;
    }
    .login-logo {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px;
      text-align: center;
    }
    .login-logo .logo-icon {
      width: 52px; height: 52px;
      background: linear-gradient(135deg, var(--accent), var(--accent-blue));
      border-radius: 14px;
      display: flex; align-items: center; justify-content: center;
      font-size: 26px;
    }
    .login-logo .logo-name {
      font-size: 1.35em;
      font-weight: 700;
      letter-spacing: 0.03em;
    }
    .login-logo .logo-sub {
      font-size: 0.82em;
      opacity: 0.55;
      margin-top: -2px;
    }
    .login-form {
      width: 100%;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .form-field {
      display: flex;
      flex-direction: column;
      gap: 5px;
    }
    .form-field label {
      font-size: 0.82em;
      opacity: 0.65;
      font-weight: 500;
    }
    .form-field input {
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 6px;
      color: var(--vscode-input-foreground);
      padding: 9px 12px;
      font-size: 0.9em;
      outline: none;
      font-family: var(--vscode-font-family);
    }
    .form-field input:focus { border-color: var(--vscode-focusBorder); }
    .btn-primary {
      width: 100%;
      background: var(--accent-send);
      color: var(--accent-on);
      border: none;
      border-radius: 6px;
      padding: 11px;
      font-size: 0.9em;
      font-weight: 700;
      cursor: pointer;
      font-family: var(--vscode-font-family);
    }
    .btn-primary:hover { filter: brightness(1.08); }
    .btn-primary:disabled { opacity: 0.45; cursor: not-allowed; }
    .login-divider {
      display: flex; align-items: center; gap: 10px; width: 100%;
      opacity: 0.45; font-size: 0.78em;
    }
    .login-divider::before, .login-divider::after {
      content: ''; flex: 1; height: 1px; background: var(--vscode-panel-border);
    }
    .auth-btns { display: flex; gap: 10px; width: 100%; }
    .btn-auth {
      flex: 1;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      color: var(--vscode-foreground);
      padding: 9px 8px;
      font-size: 0.82em;
      cursor: pointer;
      display: flex; align-items: center; justify-content: center; gap: 6px;
      font-family: var(--vscode-font-family);
    }
    .btn-auth:hover:not(:disabled) { border-color: var(--accent); }
    .btn-auth:disabled { opacity: 0.4; cursor: not-allowed; }
    .login-codex-note {
      background: color-mix(in srgb, var(--vscode-testing-iconPassed) 8%, transparent);
      border: 1px solid color-mix(in srgb, var(--vscode-testing-iconPassed) 28%, transparent);
      border-radius: 6px;
      padding: 10px 12px;
      font-size: 0.8em;
      color: var(--vscode-testing-iconPassed);
      display: flex; align-items: flex-start; gap: 8px;
      width: 100%;
      line-height: 1.45;
    }
    .login-error {
      width: 100%;
      padding: 8px 10px;
      border-radius: 6px;
      font-size: 0.82em;
      background: color-mix(in srgb, var(--vscode-inputValidation-errorBackground, #f38ba8) 35%, transparent);
      color: var(--vscode-inputValidation-errorForeground, #f38ba8);
      border: 1px solid color-mix(in srgb, var(--vscode-inputValidation-errorBorder, #f38ba8) 35%, transparent);
      display: none;
    }
    .login-error.visible { display: block; }
    .login-skip {
      font-size: 0.78em;
      opacity: 0.45;
      background: none;
      border: none;
      color: inherit;
      cursor: pointer;
      text-decoration: underline;
      font-family: var(--vscode-font-family);
    }
  </style>
</head>
<body>
  <!-- Quchi login gate -->
  <div class="login-gate visible" id="loginGate">
    <div class="login-screen">
      <div class="login-logo">
        <div class="logo-icon">🤖</div>
        <div class="logo-name">Fast OPC</div>
        <div class="logo-sub">Quchi 授权登录</div>
      </div>

      <div class="login-error" id="loginError"></div>

      <div class="login-form">
        <button class="btn-primary" id="loginSubmitBtn" type="button">登录 Quchi</button>
      </div>

      <div class="login-codex-note" id="quchiDevicePanel" style="display:none;">
        <span class="note-icon">🔐</span>
        <span id="quchiDeviceText"></span>
      </div>
      <button class="btn-primary" id="quchiOpenBtn" type="button" style="display:none; margin-top:10px;">打开授权页面</button>
      <button class="login-skip" id="quchiCopyBtn" type="button" style="display:none; margin-top:8px;">复制授权码</button>

      <div class="login-codex-note" id="loginNote">
        <span class="note-icon">⚡</span>
        <span id="loginNoteText">授权成功后才会连接 FastOPC Agent 并允许对话。</span>
      </div>
    </div>
  </div>

  <!-- ── Header ── -->
  <header class="app-header">
    <span class="header-logo">AI</span>
    <div class="header-spacer"></div>
    <div class="hdr-badge-wrap" id="historyBadgeWrap">
      <button class="icon-btn" id="historyBtn" title="Session history">
        <svg viewBox="0 0 16 16"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 1.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11zM8 4v4.25l2.5 1.5-.75 1.23L6.5 8.67V4H8z"/></svg>
      </button>
      <span class="badge-dot"></span>
    </div>
    <button class="icon-btn new-agent-btn" id="newChatBtn" title="New FastOPC conversation">＋</button>
    <button class="avatar-btn" id="avatarBtn" title="Account">AU</button>
  </header>

  <!-- ── Tab bar (rendered by JS) ── -->
  <div class="tab-bar" id="tabBar"></div>

  <!-- ── Connected banner ── -->
  <div class="session-banner" id="sessionBanner">
    <span class="dot"></span>
    <span class="agent" id="bannerAgent"></span>
    <span class="connected-label">connected</span>
    <span class="cwd" id="bannerCwd"></span>
  </div>

  <!-- ── Messages ── -->
  <div class="messages" id="messages">
    <div class="empty-state" id="emptyState">
      <div class="home-screen">
        <div class="home-brand">
          <div class="home-logo">🤖</div>
          <div class="home-title">AI 助手</div>
          <div class="home-subtitle">登录 Quchi 后将自动连接 FastOPC Agent。</div>
        </div>
        <nav class="home-menu" id="homeMenu" aria-label="Quick actions">
          <button class="home-menu-item active" type="button" data-action="chat">
            <span class="hmi-icon"><svg viewBox="0 0 24 24"><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8 8 0 0 1-7.6 4.7 8 8 0 0 1-4.7-1.5L3 21l1.5-4.8A8 8 0 1 1 21 11.5z"/></svg></span>
            <span class="hmi-label">智能对话</span>
          </button>
          <button class="home-menu-item" type="button" data-action="generate">
            <span class="hmi-icon"><svg viewBox="0 0 24 24"><path d="M16 18 22 12l-6-6M8 6v12h12"/></svg></span>
            <span class="hmi-label">代码生成</span>
          </button>
          <button class="home-menu-item" type="button" data-action="review">
            <span class="hmi-icon"><svg viewBox="0 0 24 24"><path d="M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg></span>
            <span class="hmi-label">代码审查</span>
          </button>
          <button class="home-menu-item" type="button" data-action="explain">
            <span class="hmi-icon"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.9.3-1.5 1-1.5 2.2M12 17h.01"/></svg></span>
            <span class="hmi-label">代码解释</span>
          </button>
          <button class="home-menu-item" type="button" data-action="tests">
            <span class="hmi-icon"><svg viewBox="0 0 24 24"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><path d="M14 2v6h6M9 13h6M9 17h6"/></svg></span>
            <span class="hmi-label">生成测试</span>
          </button>
          <button class="home-menu-item" type="button" data-action="docs">
            <span class="hmi-icon"><svg viewBox="0 0 24 24"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg></span>
            <span class="hmi-label">生成文档</span>
          </button>
          <button class="home-menu-item" type="button" data-action="history">
            <span class="hmi-icon"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg></span>
            <span class="hmi-label">会话历史</span>
          </button>
        </nav>
        <div class="home-section" id="homeAgentsSection">
          <div class="home-section-title">Agents</div>
          <div class="agent-cards" id="agentCards"></div>
        </div>
      </div>
      <button class="empty-connect-btn" id="emptyConnectBtn" type="button">Connect</button>
    </div>
    <!-- Session home: skill shortcuts shown after connecting with empty chat -->
    <div class="session-home" id="sessionHome" style="display:none"></div>
  </div>

  <!-- ── Input area ── -->
  <div class="input-area" id="inputArea">
    <div class="slash-popup" id="slashPopup">
      <div class="slash-popup-header">Commands</div>
    </div>
    <div class="input-card">
      <!-- Attachment pills -->
      <div class="attach-pills" id="attachPills"></div>
      <!-- Textarea -->
      <textarea id="promptInput" placeholder="Type a message..." rows="2"></textarea>
      <!-- Toolbar -->
      <div class="input-footer">
        <div class="footer-left">
          <button class="toolbar-mini" id="attachBtn" title="Attach file">
            <svg viewBox="0 0 16 16"><path d="M8.5 2.5a3.5 3.5 0 0 0-3.5 3.5v5a2 2 0 0 0 4 0V6.5a.5.5 0 0 0-1 0v4.5a1 1 0 1 1-2 0v-5a2.5 2.5 0 0 1 5 0v5.5a3.5 3.5 0 0 1-7 0V6a.5.5 0 0 1 1 0v4.5a2.5 2.5 0 0 0 5 0V6a3.5 3.5 0 0 0-7 0v5.5a4.5 4.5 0 0 0 9 0V6.5a4 4 0 0 0-8 0v5a3 3 0 0 0 6 0V7a.5.5 0 0 0-1 0v4.5a2 2 0 1 1-4 0v-5a3 3 0 0 1 6 0v5.5a4 4 0 0 1-8 0V6a.5.5 0 0 1 1 0z"/></svg>
          </button>
          <button class="toolbar-mini" id="slashBtn" title="Commands" style="display:none">
            <svg viewBox="0 0 16 16"><path d="M3 2.5 12.5 13H10L9.5 12H5.5L5 13H2.5L3 2.5zm1.2 2 3.2 6h1.2l3.2-6H4.2z"/></svg>
          </button>
          <span class="selection-badge hidden" id="selectionBadge">
            <svg viewBox="0 0 16 16"><path d="M3 2.5A1.5 1.5 0 0 1 4.5 1h7A1.5 1.5 0 0 1 13 2.5v11A1.5 1.5 0 0 1 11.5 15h-7A1.5 1.5 0 0 1 3 13.5v-11zM4.5 2a.5.5 0 0 0-.5.5v11a.5.5 0 0 0 .5.5h7a.5.5 0 0 0 .5-.5v-11a.5.5 0 0 0-.5-.5h-7z"/></svg>
            <span id="selectionText"></span>
          </span>
        </div>
        <div class="footer-right">
          <div class="footer-controls">
            <div class="picker-row" id="configOptionsContainer"></div>
            <div class="picker-wrap hidden" id="modePickerWrap">
              <button class="picker-btn" id="modePickerBtn" title="Select mode">
                <span class="picker-icon">⚡</span>
                <span class="picker-label" id="modePickerLabel">Mode</span>
                <span class="picker-chevron">▾</span>
              </button>
              <div class="picker-dropdown" id="modeDropdown"></div>
            </div>
            <div class="picker-wrap hidden" id="modelPickerWrap">
              <button class="picker-btn" id="modelPickerBtn" title="Select model">
                <span class="picker-icon">🧠</span>
                <span class="picker-label" id="modelPickerLabel">Model</span>
                <span class="picker-chevron">▾</span>
              </button>
              <div class="picker-dropdown" id="modelDropdown"></div>
            </div>
          </div>
          <button class="send-btn" id="sendStopBtn" title="Send">
            <svg viewBox="0 0 16 16"><path d="M8 2.5v11M8 2.5L4 6.5M8 2.5l4 4" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>
      </div>
    </div>
  </div>

  <div class="picker-tooltip" id="pickerTooltip" role="tooltip"></div>
  <div class="load-overlay" id="loadOverlay" role="status" aria-live="polite">
    <div class="spinner"></div>
    <div class="label">Loading conversation history…</div>
  </div>

  <div class="history-backdrop" id="historyBackdrop"></div>
  <div class="history-panel" id="historyPanel">
    <div class="history-header">
      <span style="font-size:16px;">📋</span>
      <h3>Session History</h3>
      <button class="history-close" id="historyCloseBtn" type="button" title="Close">✕</button>
    </div>
    <div class="history-search">
      <input id="historySearch" type="text" placeholder="Search sessions…" />
    </div>
    <div class="history-list" id="historyList"></div>
  </div>

  <script nonce="${nonce}">
    const HOME_SKILLS = ${homeSkillsJson};

    function homeSkillById(id) {
      return HOME_SKILLS.find(s => s.id === id);
    }
    const vscode = acquireVsCodeApi();
    function dbg(msg) {
      try { vscode.postMessage({ type: 'webviewLog', message: msg }); } catch (e) {
        console.error('[FastOPC Webview]', msg, e);
      }
    }
    dbg('script start');

    const messagesEl = document.getElementById('messages');
    const emptyState = document.getElementById('emptyState');
    const promptInput = document.getElementById('promptInput');
    const sendStopBtn = document.getElementById('sendStopBtn');
    const inputArea = document.getElementById('inputArea');
    const slashPopup = document.getElementById('slashPopup');
    const selectionBadge = document.getElementById('selectionBadge');
    const selectionText = document.getElementById('selectionText');
    const modeLabel = document.getElementById('modeLabel');
    const modeLabelText = document.getElementById('modeLabelText');
    const historyBtn = document.getElementById('historyBtn');
    const newChatBtn = document.getElementById('newChatBtn');
    const attachBtn = document.getElementById('attachBtn');
    const slashBtn = document.getElementById('slashBtn');
    // New UI refs
    const tabBar = document.getElementById('tabBar');
    const sessionBanner = document.getElementById('sessionBanner');
    const bannerAgent = document.getElementById('bannerAgent');
    const bannerCwd = document.getElementById('bannerCwd');
    const attachPills = document.getElementById('attachPills');
    const historyBadgeWrap = document.getElementById('historyBadgeWrap');
    const avatarBtn = document.getElementById('avatarBtn');
    const emptyConnectBtn = document.getElementById('emptyConnectBtn');
    const agentCards = document.getElementById('agentCards');
    const homeMenu = document.getElementById('homeMenu');
    const homeAgentsSection = document.getElementById('homeAgentsSection');
    const sessionHome = document.getElementById('sessionHome');
    const historyPanel = document.getElementById('historyPanel');
    const historyBackdrop = document.getElementById('historyBackdrop');
    const historyCloseBtn = document.getElementById('historyCloseBtn');
    const historySearch = document.getElementById('historySearch');
    const historyList = document.getElementById('historyList');
    const loginGate = document.getElementById('loginGate');
    const loginError = document.getElementById('loginError');
    const loginSubmitBtn = document.getElementById('loginSubmitBtn');
    const quchiDevicePanel = document.getElementById('quchiDevicePanel');
    const quchiDeviceText = document.getElementById('quchiDeviceText');
    const quchiOpenBtn = document.getElementById('quchiOpenBtn');
    const quchiCopyBtn = document.getElementById('quchiCopyBtn');
    const loginNoteText = document.getElementById('loginNoteText');

    const sendIconSvg = '<svg viewBox="0 0 16 16"><path d="M8 2.5v11M8 2.5L4 6.5M8 2.5l4 4" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const stopIconSvg = '<svg viewBox="0 0 16 16"><rect x="4.5" y="4.5" width="7" height="7" rx="1" fill="currentColor"/></svg>';

    let configuredAgents = [];
    let sessionHistory = [];
    let streamingCursorEl = null;
    let authLoggedIn = false;
    let quchiAuth = null;
    let loginBusy = false;
    let loginBusyTimer = null;
    let quchiPollTimer = null;

    // Picker elements
    const modePickerWrap = document.getElementById('modePickerWrap');
    const modePickerBtn = document.getElementById('modePickerBtn');
    const modePickerLabel = document.getElementById('modePickerLabel');
    const modeDropdown = document.getElementById('modeDropdown');
    const modelPickerWrap = document.getElementById('modelPickerWrap');
    const modelPickerBtn = document.getElementById('modelPickerBtn');
    const modelPickerLabel = document.getElementById('modelPickerLabel');
    const modelDropdown = document.getElementById('modelDropdown');
    const configOptionsContainer = document.getElementById('configOptionsContainer');

    let hasActiveSession = false;
    let isProcessing = false;

    // Modes / models state (legacy fallback path)
    let availableModes = [];
    let currentModeId = null;
    let availableModels = [];
    let currentModelId = null;

    // ACP Session Config Options state (preferred path)
    let configOptions = [];        // SessionConfigOption[]
    let useConfigOptions = false;  // true when the agent provided configOptions

    // Thinking state
    let currentThoughtEl = null;
    let currentThoughtTextEl = null;
    let currentThoughtText = '';
    let thoughtStartTime = null;
    let thoughtEndTime = null;

    // Slash commands state
    let availableCommands = [];
    let slashPopupSelectedIdx = -1;
    let slashFilteredCommands = [];
    let savedPlaceholder = 'Type a message...';
    let attachHint = 'Esc to attach selected text';
    let pendingSelectionText = '';

    // ── Tab state ──────────────────────────────────────────────────
    // Each tab: { id, sessionId, agentName, title, isActive }
    let tabs = [];
    let activeTabId = null;

    // ── Attachment state ───────────────────────────────────────────
    // Each entry: { name, path }
    let attachedFiles = [];

    function showLoginError(msg) {
      if (!loginError) return;
      if (msg) {
        loginError.textContent = msg;
        loginError.classList.add('visible');
      } else {
        loginError.textContent = '';
        loginError.classList.remove('visible');
      }
    }

    function setLoginBusy(busy) {
      loginBusy = busy;
      if (loginSubmitBtn) {
        loginSubmitBtn.disabled = busy;
        loginSubmitBtn.textContent = busy ? '正在获取授权码…' : '登录 Quchi';
      }
    }

    function renderQuchiDeviceState(state) {
      quchiAuth = state || quchiAuth;
      if (!quchiDevicePanel || !quchiDeviceText) return;
      const hasCode = quchiAuth && quchiAuth.userCode && quchiAuth.verificationUri;
      quchiDevicePanel.style.display = hasCode ? 'flex' : 'none';
      if (quchiOpenBtn) quchiOpenBtn.style.display = hasCode ? 'block' : 'none';
      if (quchiCopyBtn) quchiCopyBtn.style.display = hasCode ? 'block' : 'none';
      if (hasCode) {
        quchiDeviceText.innerHTML = '打开授权页并输入授权码：<strong>' + escapeHtml(quchiAuth.userCode) + '</strong><br/><span style="opacity:.7">' + escapeHtml(quchiAuth.verificationUri) + '</span>';
      }
    }

    function applyAuthState(auth) {
      if (!auth) return;
      authLoggedIn = auth.loggedIn === true;
      quchiAuth = auth.quchi || quchiAuth;
      setLoginBusy(false);

      if (loginGate) {
        loginGate.classList.toggle('visible', !authLoggedIn);
      }

      if (avatarBtn) {
        avatarBtn.textContent = authLoggedIn ? 'Q' : 'AU';
        avatarBtn.title = authLoggedIn ? 'Quchi 已授权 — 点击退出' : '登录 Quchi';
      }

      if (loginNoteText && auth.autoConnectAgent) {
        loginNoteText.innerHTML = 'Quchi 授权成功后将自动连接 <strong>' + escapeHtml(auth.autoConnectAgent) + '</strong>。';
      }

      renderQuchiDeviceState(quchiAuth);

      if (authLoggedIn) {
        showLoginError('');
        setLoginBusy(false);
        if (quchiPollTimer) clearInterval(quchiPollTimer);
        quchiPollTimer = null;
      }
    }

    function scheduleQuchiPoll() {
      if (!quchiAuth || !quchiAuth.deviceCode || quchiPollTimer) return;
      const intervalMs = Math.max(1, quchiAuth.interval || 3) * 1000;
      quchiPollTimer = setInterval(() => {
        if (!quchiAuth || !quchiAuth.deviceCode || authLoggedIn) return;
        vscode.postMessage({ type: 'quchiPollAuth', deviceCode: quchiAuth.deviceCode });
      }, intervalMs);
    }

    function startQuchiLogin() {
      dbg('startQuchiLogin click authLoggedIn=' + authLoggedIn + ' loginBusy=' + loginBusy);
      if (authLoggedIn) {
        dbg('startQuchiLogin skipped: already logged in');
        return;
      }
      showLoginError('');
      setLoginBusy(true);
      if (loginBusyTimer) clearTimeout(loginBusyTimer);
      loginBusyTimer = setTimeout(() => {
        if (loginBusy && !authLoggedIn) {
          setLoginBusy(false);
          showLoginError('获取授权码超时，请重试或查看 Output「ACP Client」。');
          dbg('startQuchiLogin client timeout');
        }
      }, 50000);
      try {
        vscode.postMessage({ type: 'quchiSignIn' });
        dbg('startQuchiLogin postMessage quchiSignIn sent');
      } catch (err) {
        setLoginBusy(false);
        dbg('startQuchiLogin postMessage failed: ' + String(err));
        showLoginError('无法连接扩展，请重载窗口后重试。');
      }
    }

    function openQuchiVerification() {
      if (quchiAuth && quchiAuth.verificationUri) {
        vscode.postMessage({ type: 'quchiOpenVerificationUri', uri: quchiAuth.verificationUri });
      } else {
        startQuchiLogin();
      }
    }

    dbg('loginSubmitBtn=' + !!loginSubmitBtn + ' quchiOpenBtn=' + !!quchiOpenBtn);
    if (loginSubmitBtn) {
      loginSubmitBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        startQuchiLogin();
      });
    } else {
      dbg('ERROR: #loginSubmitBtn not found in DOM');
    }
    if (quchiOpenBtn) {
      quchiOpenBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openQuchiVerification();
      });
    }
    if (quchiCopyBtn) {
      quchiCopyBtn.addEventListener('click', (e) => {
        e.preventDefault();
        if (quchiAuth && quchiAuth.userCode) {
          vscode.postMessage({ type: 'quchiCopyUserCode', userCode: quchiAuth.userCode });
        }
      });
    }
    if (avatarBtn) {
      avatarBtn.addEventListener('click', () => {
        if (authLoggedIn) {
          vscode.postMessage({ type: 'quchiSignOut' });
        } else {
          if (loginGate) loginGate.classList.add('visible');
        }
      });
    }

    function updatePlaceholder() {
      const agentName = sessionState && sessionState.agentName ? sessionState.agentName : '';
      const sessionHint = agentName
        ? 'Message ' + agentName + '…'
        : (availableCommands.length > 0 ? 'Type a message or / for commands…' : attachHint);
      savedPlaceholder = sessionHint;
      if (!promptInput.value.startsWith('/')) {
        promptInput.placeholder = sessionHint;
      }
    }

    function updateSelectionBadge(lines) {
      if (!selectionBadge || !selectionText) return;
      if (lines > 0) {
        selectionText.textContent = lines + ' line' + (lines !== 1 ? 's' : '') + ' selected';
        selectionBadge.classList.remove('hidden');
      } else {
        selectionBadge.classList.add('hidden');
      }
    }

    function updateModeLabel() {
      if (!modeLabel || !modeLabelText) return;
      // Hide static label when interactive pickers are shown
      if (!modePickerWrap.classList.contains('hidden') || !modelPickerWrap.classList.contains('hidden') ||
          (configOptionsContainer && configOptionsContainer.children.length > 0)) {
        modeLabel.classList.remove('visible');
        return;
      }
      modeLabelText.textContent = 'Edit automatically';
      modeLabel.classList.add('visible');
    }

    const HOME_PROMPTS = Object.fromEntries(
      HOME_SKILLS.filter(s => s.prompt).map(s => [s.id, s.prompt])
    );

    if (homeMenu) {
      HOME_SKILLS.forEach(skill => {
        const btn = homeMenu.querySelector('[data-action="' + skill.id + '"]');
        if (btn) {
          btn.title = skill.description + ' — ' + skill.skillPath;
          const label = btn.querySelector('.hmi-label');
          if (label) label.textContent = skill.label;
        }
      });
    }

    function resizePromptInput() {
      if (!promptInput) return;
      promptInput.style.height = 'auto';
      promptInput.style.height = Math.min(promptInput.scrollHeight, 160) + 'px';
    }

    function focusComposer(text) {
      if (!promptInput) return;
      if (typeof text === 'string') {
        promptInput.value = text;
        resizePromptInput();
      }
      promptInput.focus();
    }

    function setHomeMenuActive(action) {
      if (!homeMenu) return;
      homeMenu.querySelectorAll('.home-menu-item').forEach(el => {
        el.classList.toggle('active', el.dataset.action === action);
      });
    }

    function handleHomeAction(action) {
      if (!action) return;
      setHomeMenuActive(action);
      if (action === 'chat') {
        focusComposer();
        return;
      }
      if (action === 'history') {
        openHistoryPanel();
        return;
      }
      const skill = homeSkillById(action);
      if (skill && skill.skillPath) {
        focusComposer('/' + skill.skillPath + ' ');
        return;
      }
    }

    if (homeMenu) {
      homeMenu.addEventListener('click', (e) => {
        const target = e.target;
        if (!(target instanceof Element)) return;
        const item = target.closest('.home-menu-item');
        if (!item || !item.dataset.action) return;
        handleHomeAction(item.dataset.action);
      });
    }

    // Build session-home skill chips
    if (sessionHome) {
      const chips = HOME_SKILLS.filter(s => s.skillPath).map(s =>
        '<button class="skill-chip" type="button" data-skill-path="' + escapeAttr(s.skillPath) + '" title="' + escapeAttr(s.description) + '">' +
        escapeHtml(s.label) +
        '<span class="sc-slash">/' + escapeHtml(s.skillPath) + '</span>' +
        '</button>'
      ).join('');
      sessionHome.innerHTML =
        '<div class="session-home-title">快速开始</div>' +
        '<div class="session-home-chips">' + chips + '</div>';

      sessionHome.addEventListener('click', e => {
        const chip = e.target.closest('.skill-chip');
        if (!chip) return;
        const path = chip.dataset.skillPath;
        if (!path) return;
        const slash = '/' + path + ' ';
        promptInput.value = slash;
        resizePromptInput();
        promptInput.focus();
        promptInput.selectionStart = promptInput.selectionEnd = slash.length;
      });
    }

    function agentIcon(name) {
      const n = (name || '').toLowerCase();
      if (n.includes('codex')) return '⚡';
      if (n.includes('claude')) return '✱';
      if (n.includes('copilot')) return '🐙';
      if (n.includes('gemini')) return '💎';
      if (n.includes('ollama')) return '🦙';
      return '🤖';
    }

    function renderAgentCards(agents) {
      if (!agentCards) return;
      configuredAgents = agents || [];
      agentCards.innerHTML = configuredAgents.map(a => {
        const cls = 'agent-card' + (a.connected ? ' connected' : '');
        const status = a.connected
          ? '<span class="ac-status on">● connected</span>'
          : '<span class="ac-status off">○ auto-connect</span>';
        return '<div class="' + cls + '" data-agent="' + escapeAttr(a.name) + '">' +
          '<span class="ac-icon">' + agentIcon(a.name) + '</span>' +
          '<div class="ac-info">' +
          '<div class="ac-name">' + escapeHtml(a.displayName || a.name) + '</div>' +
          '<div class="ac-desc">' + (a.connected ? '已连接' : '授权后自动连接') + '</div>' +
          '</div>' + status + '</div>';
      }).join('');
    }

    if (agentCards) {
      agentCards.addEventListener('click', (e) => {
        const target = e.target;
        if (!(target instanceof Element)) return;
        const card = target.closest('[data-agent]');
        if (card) vscode.postMessage({ type: 'connectAgent' });
      });
    }

    function formatHistoryTime(iso) {
      if (!iso) return '';
      try {
        const d = new Date(iso);
        const now = new Date();
        const sameDay = d.toDateString() === now.toDateString();
        if (sameDay) {
          return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        }
        return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
      } catch { return ''; }
    }

    function groupHistoryLabel(iso) {
      if (!iso) return 'Older';
      try {
        const d = new Date(iso);
        const now = new Date();
        const yesterday = new Date(now);
        yesterday.setDate(yesterday.getDate() - 1);
        if (d.toDateString() === now.toDateString()) return 'Today';
        if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
        return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
      } catch { return 'Older'; }
    }

    function renderHistoryPanel(filter) {
      if (!historyList) return;
      const q = (filter || '').trim().toLowerCase();
      let items = sessionHistory.slice();
      if (q) {
        items = items.filter(h =>
          (h.title || '').toLowerCase().includes(q) ||
          (h.preview || '').toLowerCase().includes(q) ||
          (h.agentName || '').toLowerCase().includes(q)
        );
      }
      if (items.length === 0) {
        historyList.innerHTML = '<div class="history-empty">No sessions yet</div>';
        return;
      }
      let html = '';
      let lastGroup = '';
      for (const h of items) {
        const group = groupHistoryLabel(h.lastActiveAt);
        if (group !== lastGroup) {
          html += '<div class="history-group-label">' + escapeHtml(group) + '</div>';
          lastGroup = group;
        }
        html += '<div class="history-item' + (h.isActive ? ' active' : '') + '" data-agent="' + escapeAttr(h.agentName) + '" data-session="' + escapeAttr(h.sessionId) + '">' +
          '<div class="hi-top">' +
          '<span class="hi-dot"></span>' +
          '<span class="hi-title">' + escapeHtml(h.title || 'Untitled') + '</span>' +
          '<span class="hi-time">' + formatHistoryTime(h.lastActiveAt) + '</span>' +
          '</div>' +
          (h.preview ? '<div class="hi-preview">' + escapeHtml(h.preview) + '</div>' : '') +
          '</div>';
      }
      historyList.innerHTML = html;
    }

    function openHistoryPanel() {
      renderHistoryPanel(historySearch ? historySearch.value : '');
      if (historyPanel) historyPanel.classList.add('open');
      if (historyBackdrop) historyBackdrop.classList.add('open');
    }

    function closeHistoryPanel() {
      if (historyPanel) historyPanel.classList.remove('open');
      if (historyBackdrop) historyBackdrop.classList.remove('open');
    }

    if (historyBtn) historyBtn.addEventListener('click', () => openHistoryPanel());
    if (historyCloseBtn) historyCloseBtn.addEventListener('click', () => closeHistoryPanel());
    if (historyBackdrop) historyBackdrop.addEventListener('click', () => closeHistoryPanel());
    if (historySearch) historySearch.addEventListener('input', () => renderHistoryPanel(historySearch.value));
    if (historyList) {
      historyList.addEventListener('click', (e) => {
        const target = e.target;
        if (!(target instanceof Element)) return;
        const item = target.closest('.history-item');
        if (!item) return;
        closeHistoryPanel();
        vscode.postMessage({
          type: 'tabSwitch',
          agentName: item.dataset.agent,
          sessionId: item.dataset.session,
        });
      });
    }

    function showStreamingCursor() {
      removeStreamingCursor();
      if (!currentAssistantEl) return;
      streamingCursorEl = document.createElement('span');
      streamingCursorEl.className = 'cursor-blink';
      currentAssistantEl.appendChild(streamingCursorEl);
    }

    function removeStreamingCursor() {
      if (streamingCursorEl && streamingCursorEl.parentNode) {
        streamingCursorEl.parentNode.removeChild(streamingCursorEl);
      }
      streamingCursorEl = null;
    }

    function updateStreamingAssistantText() {
      if (!currentAssistantEl) return;
      if (currentAssistantEl.classList.contains('md-rendered')) {
        currentAssistantEl.classList.remove('md-rendered');
      }
      currentAssistantEl.textContent = currentAssistantText;
      showStreamingCursor();
    }
    function renderTabBar() {
      if (!tabBar) return;
      if (tabs.length === 0) {
        tabBar.innerHTML = '';
        return;
      }
      tabBar.innerHTML = tabs.map(t => {
        const isActive = t.id === activeTabId;
        const dotClass = t.agentName ? 'tab-dot' : 'tab-dot idle';
        return '<div class="tab' + (isActive ? ' active' : '') + '" data-tab-id="' + escapeAttr(t.id) + '">' +
          '<span class="' + dotClass + '"></span>' +
          '<span class="tab-title" title="' + escapeAttr(t.title || 'New Chat') + '">' +
          escapeHtml(t.title || 'New Chat') + '</span>' +
          '<span class="tab-close" data-close-tab-id="' + escapeAttr(t.id) + '">✕</span>' +
          '</div>';
      }).join('');
    }

    function escapeAttr(str) {
      return String(str || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function ensureTab(sessionId, agentName, title) {
      const existing = tabs.find(t => t.sessionId === sessionId);
      if (existing) {
        existing.agentName = agentName || existing.agentName;
        if (title) existing.title = title;
        activeTabId = existing.id;
        tabs.forEach(t => t.isActive = t.id === activeTabId);
        renderTabBar();
        return existing;
      }
      const id = 'tab-' + Date.now();
      const tab = { id, sessionId, agentName: agentName || '', title: title || '', isActive: true };
      tabs.push(tab);
      tabs.forEach(t => t.isActive = t.id === id);
      activeTabId = id;
      renderTabBar();
      if (historyBadgeWrap) historyBadgeWrap.classList.toggle('has-history', tabs.length > 1);
      return tab;
    }

    function updateActiveTabTitle(title) {
      const tab = tabs.find(t => t.id === activeTabId);
      if (tab && title) {
        tab.title = title;
        renderTabBar();
        saveState();
      }
    }

    // Tab bar click delegation
    if (tabBar) {
      tabBar.addEventListener('click', (e) => {
        const target = e.target;
        if (!(target instanceof Element)) return;
        // Close button
        const closeEl = target.closest('[data-close-tab-id]');
        if (closeEl) {
          e.stopPropagation();
          const tabId = closeEl.dataset.closeTabId;
          const tab = tabs.find(t => t.id === tabId);
          if (tab) {
            tabs = tabs.filter(t => t.id !== tabId);
            if (activeTabId === tabId) {
              activeTabId = tabs.length > 0 ? tabs[tabs.length - 1].id : null;
              // Trigger session switch or clear
              if (activeTabId) {
                const nextTab = tabs.find(t => t.id === activeTabId);
                if (nextTab && nextTab.sessionId) {
                  vscode.postMessage({ type: 'executeCommand', command: 'acp.openSession',
                    args: [{ agentName: nextTab.agentName, sessionId: nextTab.sessionId }] });
                }
              } else {
                vscode.postMessage({ type: 'tabClose', agentName: tab.agentName, sessionId: tab.sessionId });
              }
            }
            renderTabBar();
            saveState();
          }
          return;
        }
        // Tab click
        const tabEl = target.closest('[data-tab-id]');
        if (tabEl) {
          const tabId = tabEl.dataset.tabId;
          if (tabId === activeTabId) return;
          const tab = tabs.find(t => t.id === tabId);
          if (tab) {
            activeTabId = tabId;
            tabs.forEach(t => t.isActive = t.id === tabId);
            renderTabBar();
            if (tab.sessionId) {
              vscode.postMessage({ type: 'tabSwitch', agentName: tab.agentName, sessionId: tab.sessionId });
            }
            saveState();
          }
        }
      });
    }

    // ── Attachment pills ───────────────────────────────────────────
    function renderAttachPills() {
      if (!attachPills) return;
      if (attachedFiles.length === 0) {
        attachPills.innerHTML = '';
        attachPills.classList.remove('has-pills');
        return;
      }
      attachPills.classList.add('has-pills');
      attachPills.innerHTML = attachedFiles.map((f, i) =>
        '<div class="attach-pill" data-pill-idx="' + i + '">' +
        '<span class="pill-icon">📎</span>' +
        '<span class="pill-name" title="' + escapeAttr(f.path) + '">' + escapeHtml(f.name) + '</span>' +
        '<span class="pill-remove" data-remove-idx="' + i + '">✕</span>' +
        '</div>'
      ).join('');
    }

    if (attachPills) {
      attachPills.addEventListener('click', (e) => {
        const target = e.target;
        if (!(target instanceof Element)) return;
        const removeEl = target.closest('[data-remove-idx]');
        if (removeEl) {
          const idx = parseInt(removeEl.dataset.removeIdx, 10);
          attachedFiles.splice(idx, 1);
          renderAttachPills();
        }
      });
    }

    // --- State persistence ---
    let chatHistory = [];
    let sessionState = null;

    function saveState() {
      vscode.setState({ chatHistory, sessionState, hasActiveSession, tabs, activeTabId });
    }

    function restoreState() {
      const saved = vscode.getState();
      if (!saved) return;

      chatHistory = saved.chatHistory || [];
      sessionState = saved.sessionState || null;
      hasActiveSession = saved.hasActiveSession || false;
      tabs = saved.tabs || [];
      activeTabId = saved.activeTabId || null;

      renderTabBar();
      if (historyBadgeWrap) historyBadgeWrap.classList.toggle('has-history', tabs.length > 1);

      if (hasActiveSession && sessionState) {
        showSessionConnectedFromState(sessionState);
      }

      const assistantItems = [];
      for (let i = 0; i < chatHistory.length; i++) {
        const item = chatHistory[i];
        switch (item.kind) {
          case 'message':
            addMessageDOM(item.role, item.text);
            if (item.role === 'assistant') {
              assistantItems.push({ index: i, text: item.text });
            }
            break;
          case 'thought':
            addThoughtDOM(item.text, item.durationSec || 0);
            break;
          case 'toolCall':
            addToolCallDOM(item.toolCallId, item.title, item.status, item.toolKind, item.content, item.locations);
            break;
          case 'plan':
            addPlanDOM(item.plan);
            break;
        }
      }

      // Request markdown rendering for all restored assistant messages
      if (assistantItems.length > 0) {
        vscode.postMessage({ type: 'renderMarkdown', items: assistantItems });
      }
    }

    // Start with input disabled
    if (inputArea) inputArea.classList.add('disabled');
    let currentAssistantEl = null;
    let currentAssistantText = '';
    let currentTurnEl = null;       // .turn container for current response
    let currentToolsListEl = null;  // .turn-tools-list inside current turn
    let currentToolsCountEl = null; // .turn-tools-summary counter
    let currentToolCount = 0;
    let toolCalls = {};

    // Auto-resize textarea within input card
    if (!promptInput) {
      dbg('ERROR: #promptInput not found — composer disabled');
    } else promptInput.addEventListener('input', () => {
      promptInput.style.height = 'auto';
      promptInput.style.height = Math.min(promptInput.scrollHeight, 160) + 'px';

      // Slash command autocomplete
      const text = promptInput.value;
      if (text.startsWith('/') && availableCommands.length > 0) {
        const firstSpace = text.indexOf(' ');
        const query = (firstSpace > 0 ? text.slice(1, firstSpace) : text.slice(1)).toLowerCase();
        if (firstSpace < 0) {
          // Still typing command name — show filtered popup
          slashFilteredCommands = availableCommands.filter(c =>
            c.name.toLowerCase().startsWith(query)
          );
          if (slashFilteredCommands.length > 0) {
            renderSlashPopup(slashFilteredCommands);
            slashPopup.classList.add('open');
            slashPopupSelectedIdx = 0;
            highlightSlashItem(0);
          } else {
            slashPopup.classList.remove('open');
          }
        } else {
          slashPopup.classList.remove('open');
        }
      } else {
        slashPopup.classList.remove('open');
        if (!text.startsWith('/')) {
          promptInput.placeholder = savedPlaceholder;
        }
      }
    });

    // Send on Enter (Shift+Enter for newline)
    if (promptInput) promptInput.addEventListener('keydown', (e) => {
      // Slash popup navigation
      if (slashPopup.classList.contains('open')) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          slashPopupSelectedIdx = Math.min(slashPopupSelectedIdx + 1, slashFilteredCommands.length - 1);
          highlightSlashItem(slashPopupSelectedIdx);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          slashPopupSelectedIdx = Math.max(slashPopupSelectedIdx - 1, 0);
          highlightSlashItem(slashPopupSelectedIdx);
          return;
        }
        if (e.key === 'Tab') {
          e.preventDefault();
          selectSlashCommand(slashFilteredCommands[slashPopupSelectedIdx]);
          return;
        }
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          selectSlashCommand(slashFilteredCommands[slashPopupSelectedIdx]);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          slashPopup.classList.remove('open');
          return;
        }
      }

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (isProcessing) {
          handleCancel();
        } else {
          handleSend();
        }
      }
    });

    function handleSend() {
      if (!authLoggedIn) {
        if (loginGate) loginGate.classList.add('visible');
        return;
      }
      const text = promptInput.value.trim();
      if (!text || isProcessing) return;

      const attachmentsToSend = attachedFiles.slice();
      const attachmentNote = attachmentsToSend.length > 0
        ? attachmentsToSend.map(f => f.name).join(', ')
        : '';

      // Auto-title the active tab with the first message if it has no title yet
      const activeTab = tabs.find(t => t.id === activeTabId);
      if (activeTab && !activeTab.title) {
        activeTab.title = text.length > 40 ? text.slice(0, 40).trimEnd() + '…' : text;
        renderTabBar();
        saveState();
      }

      addMessage('user', text, attachmentNote);
      promptInput.value = '';
      promptInput.style.height = 'auto';
      attachedFiles = [];
      renderAttachPills();
      vscode.postMessage({ type: 'sendPrompt', text, attachments: attachmentsToSend });
    }

    function handleCancel() {
      vscode.postMessage({ type: 'cancelTurn' });
    }

    function execCmd(command) {
      vscode.postMessage({ type: 'executeCommand', command });
    }

    // Wire up buttons
    sendStopBtn.addEventListener('click', () => {
      if (isProcessing) {
        handleCancel();
      } else {
        handleSend();
      }
    });

    if (newChatBtn) newChatBtn.addEventListener('click', () => execCmd('acp.newConversation'));
    if (attachBtn) attachBtn.addEventListener('click', () => execCmd('acp.attachFile'));
    if (slashBtn) slashBtn.addEventListener('click', () => {
      promptInput.value = '/';
      promptInput.focus();
      promptInput.dispatchEvent(new Event('input'));
    });

    // --- Send/Stop toggle ---
    function setProcessing(processing) {
      isProcessing = processing;
      if (processing) {
        sendStopBtn.className = 'send-btn stop';
        sendStopBtn.innerHTML = stopIconSvg;
        sendStopBtn.title = 'Stop';
        sendStopBtn.disabled = false;
        promptInput.disabled = true;
      } else {
        sendStopBtn.className = 'send-btn';
        sendStopBtn.innerHTML = sendIconSvg;
        sendStopBtn.title = 'Send';
        sendStopBtn.disabled = false;
        promptInput.disabled = false;
      }
    }

    // --- Session/load overlay ---
    const loadOverlay = document.getElementById('loadOverlay');
    // True while a session/load replay is in progress. Used to suppress
    // per-chunk markdown rendering until the replay finishes.
    let isLoadingSession = false;

    function handleLoadSessionStart() {
      isLoadingSession = true;
      // Reset all chat state; behaves like clearChat but keeps the session
      // banner / input area structure intact.
      chatHistory = [];
      saveState();
      currentAssistantEl = null;
      currentAssistantText = '';
      toolCalls = {};
      currentTurnEl = null;
      currentToolsListEl = null;
      currentToolsCountEl = null;
      currentToolCount = 0;
      currentThoughtEl = null;
      currentThoughtTextEl = null;
      currentThoughtText = '';
      thoughtStartTime = null;
      thoughtEndTime = null;
      messagesEl.innerHTML = '';
      if (emptyState) {
        messagesEl.appendChild(emptyState);
        emptyState.style.display = 'none';
      }
      if (sessionHome) { messagesEl.appendChild(sessionHome); sessionHome.style.display = 'none'; }
      if (loadOverlay) loadOverlay.classList.add('visible');
      if (inputArea) inputArea.classList.add('disabled');
      setProcessing(false);
    }

    function handleLoadSessionEnd(ok) {
      isLoadingSession = false;
      // Commit any trailing assistant turn captured during the replay.
      finalizeCurrentAssistantTurn();
      if (loadOverlay) loadOverlay.classList.remove('visible');
      if (inputArea) inputArea.classList.remove('disabled');
      // Batch-render markdown for every assistant message captured during
      // the replay (avoids per-chunk render storms).
      const items = [];
      for (let i = 0; i < chatHistory.length; i++) {
        const item = chatHistory[i];
        if (item.kind === 'message' && item.role === 'assistant') {
          items.push({ index: i, text: item.text });
        }
      }
      if (items.length > 0) {
        vscode.postMessage({ type: 'renderMarkdown', items });
      }
      scrollToBottom();
      if (!ok) {
        addMessage('error', 'Failed to load session history.');
      }
    }

    function handleSessionInfoUpdate(title) {
      if (!sessionState) return;
      if (typeof title === 'string') {
        sessionState.title = title;
      } else if (title === null) {
        delete sessionState.title;
      }
      saveState();
      updateSessionTitle();
    }

    function updateSessionTitle() {
      if (sessionState) {
        // Only update tab with a meaningful title (not agent name)
        const title = sessionState.title;
        if (title) updateActiveTabTitle(title);
      }
    }

    /**
     * Restore a locally-persisted chat history into the view.
     * Called when the extension sends 'restoreMessages' for a historical session
     * that the agent cannot load server-side.
     */
    function handleRestoreMessages(msg) {
      // Reset all streaming state
      currentAssistantEl = null;
      currentAssistantText = '';
      toolCalls = {};
      currentTurnEl = null;
      currentToolsListEl = null;
      currentToolsCountEl = null;
      currentToolCount = 0;
      currentThoughtEl = null;
      currentThoughtTextEl = null;
      currentThoughtText = '';
      thoughtStartTime = null;
      thoughtEndTime = null;

      // Clear the message area
      messagesEl.innerHTML = '';
      if (emptyState) messagesEl.appendChild(emptyState);
      if (sessionHome) { messagesEl.appendChild(sessionHome); sessionHome.style.display = 'none'; }

      const history = Array.isArray(msg.messages) ? msg.messages : [];
      chatHistory = history;

      // Update session state to reflect this historical session
      if (msg.sessionId) {
        sessionState = {
          sessionId: msg.sessionId,
          agentName: msg.agentName || '',
          cwd: msg.cwd || '',
          title: msg.title || undefined,
        };
        ensureTab(msg.sessionId, msg.agentName || '', msg.title || '');
        showSessionConnectedFromState(sessionState);
      }

      if (history.length === 0) {
        if (emptyState) emptyState.style.display = '';
        saveState();
        return;
      }

      // Render history items
      const assistantItems = [];
      for (let i = 0; i < history.length; i++) {
        const item = history[i];
        switch (item.kind) {
          case 'message':
            addMessageDOM(item.role, item.text, item.attachmentNote);
            if (item.role === 'assistant') {
              assistantItems.push({ index: i, text: item.text });
            }
            break;
          case 'thought':
            addThoughtDOM(item.text, item.durationSec || 0);
            break;
          case 'toolCall':
            addToolCallDOM(item.toolCallId, item.title, item.status, item.toolKind, item.content, item.locations);
            break;
          case 'plan':
            addPlanDOM(item.plan);
            break;
        }
      }
      if (assistantItems.length > 0) {
        vscode.postMessage({ type: 'renderMarkdown', items: assistantItems });
      }
      hideEmpty();
      scrollToBottom();
      saveState();
    }

    // --- Mode / Model pickers ---

    // --- Slash command helpers ---
    function renderSlashPopup(commands) {
      slashPopup.innerHTML = '<div class="slash-popup-header">Commands</div>';
      commands.forEach((cmd, i) => {
        const item = document.createElement('div');
        item.className = 'slash-popup-item' + (i === 0 ? ' active' : '');
        item.dataset.index = String(i);
        item.innerHTML =
          '<span class="cmd-name">/' + escapeHtml(cmd.name) + '</span>' +
          '<span class="cmd-desc">' + escapeHtml(cmd.description) + '</span>';
        item.addEventListener('click', () => selectSlashCommand(cmd));
        item.addEventListener('mouseenter', () => {
          slashPopupSelectedIdx = i;
          highlightSlashItem(i);
        });
        slashPopup.appendChild(item);
      });
    }

    function highlightSlashItem(idx) {
      const items = slashPopup.querySelectorAll('.slash-popup-item');
      items.forEach((el, i) => el.classList.toggle('active', i === idx));
      if (items[idx]) items[idx].scrollIntoView({ block: 'nearest' });
    }

    function selectSlashCommand(cmd) {
      slashPopup.classList.remove('open');
      if (!cmd) return;

      if (cmd.input) {
        // Command expects input — insert "/name " and set placeholder to hint
        promptInput.value = '/' + cmd.name + ' ';
        promptInput.placeholder = cmd.input.hint || 'Type input...';
        promptInput.focus();
      } else {
        // No input required — send immediately
        promptInput.value = '/' + cmd.name;
        handleSend();
      }
    }

    // --- Mode / Model pickers (cont.) ---
    function updateModePicker(modes) {
      if (!modes || !modes.availableModes || modes.availableModes.length === 0) {
        modePickerWrap.classList.add('hidden');
        availableModes = [];
        currentModeId = null;
        return;
      }
      availableModes = modes.availableModes;
      currentModeId = modes.currentModeId || null;
      modePickerWrap.classList.remove('hidden');
      const current = availableModes.find(m => m.id === currentModeId);
      modePickerLabel.textContent = current ? current.name : 'Mode';
      modePickerLabel.title = current && current.description ? current.description : '';
      renderModeDropdown();
      updateModeLabel();
    }

    function modeIconFor(id, name) {
      const key = ((id || '') + ' ' + (name || '')).toLowerCase();
      if (key.includes('plan')) return '🔍';
      if (key.includes('edit')) return '✏️';
      if (key.includes('auto')) return '⚡';
      if (key.includes('full')) return '🚀';
      return '⚙';
    }

    function renderModeDropdown() {
      modeDropdown.innerHTML = '';
      for (const mode of availableModes) {
        const item = document.createElement('div');
        const selected = mode.id === currentModeId;
        item.className = 'picker-dropdown-item' + (selected ? ' selected' : '');
        item.dataset.desc = mode.description || '';
        item.dataset.label = mode.name || '';
        item.innerHTML =
          '<span class="mo-icon">' + modeIconFor(mode.id, mode.name) + '</span>' +
          '<div class="item-body">' +
          '<div class="item-label">' + escapeHtml(mode.name) + '</div>' +
          (mode.description ? '<div class="item-desc">' + escapeHtml(mode.description) + '</div>' : '') +
          '</div>' +
          '<span class="check">' + (selected ? '✓' : '') + '</span>';
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          closePickers();
          if (mode.id !== currentModeId) {
            currentModeId = mode.id;
            modePickerLabel.textContent = mode.name;
            renderModeDropdown();
            vscode.postMessage({ type: 'setMode', modeId: mode.id });
          }
        });
        modeDropdown.appendChild(item);
      }
    }

    function updateModelPicker(models) {
      if (!models || !models.availableModels || models.availableModels.length === 0) {
        modelPickerWrap.classList.add('hidden');
        availableModels = [];
        currentModelId = null;
        return;
      }
      availableModels = models.availableModels;
      currentModelId = models.currentModelId || null;
      modelPickerWrap.classList.remove('hidden');
      const current = availableModels.find(m => m.modelId === currentModelId);
      modelPickerLabel.textContent = current ? current.name : 'Model';
      modelPickerLabel.title = current && current.description ? current.description : '';
      renderModelDropdown();
    }

    function renderModelDropdown() {
      modelDropdown.innerHTML = '';
      for (const model of availableModels) {
        const item = document.createElement('div');
        item.className = 'picker-dropdown-item' + (model.modelId === currentModelId ? ' selected' : '');
        item.dataset.desc = model.description || '';
        if (model.description) item.title = model.description;
        item.innerHTML =
          '<span class="check">' + (model.modelId === currentModelId ? '✓' : '') + '</span>' +
          '<span class="item-label">' + escapeHtml(model.name) + '</span>';
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          closePickers();
          if (model.modelId !== currentModelId) {
            currentModelId = model.modelId;
            const current = availableModels.find(m => m.modelId === currentModelId);
            modelPickerLabel.textContent = current ? current.name : 'Model';
            renderModelDropdown();
            vscode.postMessage({ type: 'setModel', modelId: model.modelId });
          }
        });
        modelDropdown.appendChild(item);
      }
    }

    // --- ACP Session Config Options ---

    function iconForCategory(cat) {
      switch (cat) {
        case 'mode': return '⚡';
        case 'model': return '🧠';
        case 'thought_level': return '💭';
        default: return '⚙';
      }
    }

    function isGroupedOptions(opt) {
      const arr = opt && opt.options;
      if (!Array.isArray(arr) || arr.length === 0) return false;
      const first = arr[0];
      return !!(first && typeof first.group === 'string' && Array.isArray(first.options));
    }

    function findOptionValue(opt, value) {
      if (!opt || !Array.isArray(opt.options)) return null;
      if (isGroupedOptions(opt)) {
        for (const group of opt.options) {
          if (!group || !Array.isArray(group.options)) continue;
          const hit = group.options.find(v => v && v.value === value);
          if (hit) return hit;
        }
        return null;
      }
      return opt.options.find(v => v && v.value === value) || null;
    }

    function pickerLabelFor(opt) {
      const v = findOptionValue(opt, opt.currentValue);
      return v && v.name ? v.name : (opt.name || 'Option');
    }

    function pickerTooltipFor(opt) {
      const v = findOptionValue(opt, opt.currentValue);
      return (v && v.description) || opt.description || opt.name || '';
    }

    function renderConfigPickers(opts) {
      configOptionsContainer.innerHTML = '';
      if (!Array.isArray(opts)) return;

      for (const opt of opts) {
        // Spec: ignore unknown types and empty option lists
        if (!opt || opt.type !== 'select') continue;
        if (!Array.isArray(opt.options) || opt.options.length === 0) continue;

        const wrap = document.createElement('div');
        wrap.className = 'picker-wrap';
        wrap.dataset.configId = opt.id;

        const btn = document.createElement('button');
        btn.className = 'picker-btn';
        btn.title = pickerTooltipFor(opt);
        btn.innerHTML =
          '<span class="picker-icon">' + iconForCategory(opt.category) + '</span>' +
          '<span class="picker-label"></span>' +
          '<span class="picker-chevron">▾</span>';
        btn.querySelector('.picker-label').textContent = pickerLabelFor(opt);
        wrap.appendChild(btn);

        const dropdown = document.createElement('div');
        dropdown.className = 'picker-dropdown';
        renderConfigDropdown(dropdown, opt);
        wrap.appendChild(dropdown);

        configOptionsContainer.appendChild(wrap);
      }
    }

    function renderConfigDropdown(dropdown, opt) {
      dropdown.innerHTML = '';
      if (isGroupedOptions(opt)) {
        for (const group of opt.options) {
          if (!group || !Array.isArray(group.options)) continue;
          const header = document.createElement('div');
          header.className = 'picker-dropdown-group-header';
          header.textContent = group.name || group.group || '';
          dropdown.appendChild(header);
          for (const v of group.options) {
            dropdown.appendChild(buildConfigItem(opt, v));
          }
        }
      } else {
        for (const v of opt.options) {
          dropdown.appendChild(buildConfigItem(opt, v));
        }
      }
    }

    function buildConfigItem(opt, v) {
      const selected = v.value === opt.currentValue;
      const item = document.createElement('div');
      item.className = 'picker-dropdown-item' + (selected ? ' selected' : '');
      item.dataset.value = v.value;
      item.dataset.desc = v.description || '';
      if (v.description) item.title = v.description;
      item.innerHTML =
        '<span class="check">' + (selected ? '✓' : '') + '</span>' +
        '<span class="item-label"></span>';
      item.querySelector('.item-label').textContent = v.name || v.value;
      return item;
    }

    // Event delegation: handle clicks on dynamically-rendered config pickers
    configOptionsContainer.addEventListener('click', (e) => {
      const target = e.target;
      if (!(target instanceof Element)) return;

      const item = target.closest('.picker-dropdown-item');
      if (item) {
        e.stopPropagation();
        const wrap = item.closest('.picker-wrap');
        const dropdown = item.closest('.picker-dropdown');
        if (!wrap || !dropdown) return;
        const configId = wrap.dataset.configId;
        const value = item.dataset.value;
        if (!configId || value == null) return;

        // Find option in current state
        const opt = configOptions.find(o => o && o.id === configId);
        if (!opt || value === opt.currentValue) {
          dropdown.classList.remove('open');
          return;
        }

        // Optimistic update — agent's response will replace with authoritative state
        opt.currentValue = value;
        const labelEl = wrap.querySelector('.picker-btn .picker-label');
        const btn = wrap.querySelector('.picker-btn');
        if (labelEl) labelEl.textContent = pickerLabelFor(opt);
        if (btn) btn.title = pickerTooltipFor(opt);
        renderConfigDropdown(dropdown, opt);

        dropdown.classList.remove('open');
        vscode.postMessage({ type: 'setConfigOption', configId, value });
        return;
      }

      const btn = target.closest('.picker-btn');
      if (btn) {
        e.stopPropagation();
        const wrap = btn.closest('.picker-wrap');
        if (!wrap) return;
        const dropdown = wrap.querySelector('.picker-dropdown');
        if (!dropdown) return;
        const wasOpen = dropdown.classList.contains('open');
        closePickers();
        if (!wasOpen) openPickerDropdown(dropdown, btn);
      }
    });

    function setConfigOptionsState(opts) {
      configOptions = Array.isArray(opts) ? opts : [];
      useConfigOptions = configOptions.length > 0;

      if (useConfigOptions) {
        // Hide legacy pickers — spec requires configOptions to be used exclusively
        modePickerWrap.classList.add('hidden');
        modelPickerWrap.classList.add('hidden');
        renderConfigPickers(configOptions);
      } else {
        configOptionsContainer.innerHTML = '';
      }
      updateModeLabel();
    }

    // Toggle picker dropdowns
    modePickerBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const wasOpen = modeDropdown.classList.contains('open');
      closePickers();
      if (!wasOpen) {
        openPickerDropdown(modeDropdown, modePickerBtn);
        const selectedItem = modeDropdown.querySelector('.picker-dropdown-item.selected');
        if (selectedItem) showPickerTooltip(selectedItem, modePickerBtn);
      }
    });

    modePickerBtn.addEventListener('mouseenter', () => {
      if (modeDropdown.classList.contains('open')) return;
      showCurrentModePopover();
    });
    modePickerBtn.addEventListener('mouseleave', () => {
      if (modeDropdown.classList.contains('open')) return;
      hidePickerTooltip();
    });

    modelPickerBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const wasOpen = modelDropdown.classList.contains('open');
      closePickers();
      if (!wasOpen) openPickerDropdown(modelDropdown, modelPickerBtn);
    });

    function resetDropdownPosition(dropdown) {
      if (!dropdown) return;
      dropdown.style.position = '';
      dropdown.style.left = '';
      dropdown.style.top = '';
      dropdown.style.bottom = '';
      dropdown.style.visibility = '';
      dropdown.style.minWidth = '';
      dropdown.style.maxWidth = '';
    }

    function positionPickerDropdown(dropdown, btn) {
      if (!dropdown || !btn) return;
      dropdown.style.visibility = 'hidden';
      dropdown.style.position = 'fixed';
      dropdown.style.left = '0';
      dropdown.style.top = '0';
      dropdown.style.bottom = 'auto';
      dropdown.style.minWidth = '260px';
      dropdown.style.maxWidth = Math.min(320, window.innerWidth - 16) + 'px';

      const btnRect = btn.getBoundingClientRect();
      const dropRect = dropdown.getBoundingClientRect();
      const gap = 8;
      const margin = 8;

      let left = btnRect.left;
      if (left + dropRect.width > window.innerWidth - margin) {
        left = window.innerWidth - dropRect.width - margin;
      }
      left = Math.max(margin, left);

      let top = btnRect.top - dropRect.height - gap;
      if (top < margin) {
        top = btnRect.bottom + gap;
      }

      dropdown.style.left = left + 'px';
      dropdown.style.top = top + 'px';
      dropdown.style.visibility = '';
    }

    function openPickerDropdown(dropdown, btn) {
      if (!dropdown || !btn) return;
      const wrap = btn.closest('.picker-wrap');
      closePickers();
      dropdown.classList.add('open');
      if (wrap) wrap.classList.add('dropdown-open');
      positionPickerDropdown(dropdown, btn);
    }

    function closePickers() {
      modeDropdown.classList.remove('open');
      modelDropdown.classList.remove('open');
      resetDropdownPosition(modeDropdown);
      resetDropdownPosition(modelDropdown);
      modePickerWrap.classList.remove('dropdown-open');
      modelPickerWrap.classList.remove('dropdown-open');
      // Close any dynamic config-option dropdowns
      const open = configOptionsContainer.querySelectorAll('.picker-dropdown.open');
      open.forEach(el => {
        el.classList.remove('open');
        resetDropdownPosition(el);
        el.closest('.picker-wrap')?.classList.remove('dropdown-open');
      });
      hidePickerTooltip();
    }

    // --- Picker hover tooltip (shared by all picker dropdowns) ---
    const pickerTooltip = document.getElementById('pickerTooltip');

    function hidePickerTooltip() {
      if (pickerTooltip) pickerTooltip.classList.remove('visible');
    }

    function buildRichTooltipHtml(title, desc, selected) {
      return '<div class="pt-header">' +
        '<span class="pt-gear">⚙</span>' +
        '<span class="pt-title">' + escapeHtml(title || '') + '</span>' +
        (selected ? '<span class="pt-check">✓</span>' : '') +
        '</div>' +
        (desc ? '<div class="pt-body">' + escapeHtml(desc) + '</div>' : '');
    }

    function positionTooltipAbove(anchorEl) {
      if (!pickerTooltip || !anchorEl) return;
      const anchorRect = anchorEl.getBoundingClientRect();
      const tipRect = pickerTooltip.getBoundingClientRect();
      const gap = 8;
      let left = anchorRect.left + (anchorRect.width - tipRect.width) / 2;
      left = Math.max(4, Math.min(left, window.innerWidth - tipRect.width - 4));
      let top = anchorRect.top - tipRect.height - gap;
      if (top < 4) top = anchorRect.bottom + gap;
      pickerTooltip.style.left = left + 'px';
      pickerTooltip.style.top = top + 'px';
    }

    function showPickerTooltip(itemEl, anchorEl) {
      if (!pickerTooltip || !itemEl) return;
      const desc = itemEl.dataset && itemEl.dataset.desc;
      const labelEl = itemEl.querySelector('.item-label');
      const title = (itemEl.dataset && itemEl.dataset.label) || (labelEl && labelEl.textContent) || '';
      if (!desc && !title) { hidePickerTooltip(); return; }

      const selected = itemEl.classList.contains('selected');
      pickerTooltip.innerHTML = buildRichTooltipHtml(title, desc, selected);
      pickerTooltip.style.left = '-9999px';
      pickerTooltip.style.top = '-9999px';
      pickerTooltip.classList.add('visible');

      const anchor = anchorEl || itemEl.closest('.picker-wrap')?.querySelector('.picker-btn') || itemEl;
      positionTooltipAbove(anchor);
    }

    function showCurrentModePopover() {
      if (modePickerWrap.classList.contains('hidden')) return;
      const current = availableModes.find(m => m.id === currentModeId);
      if (!current || !current.description) return;
      const fake = document.createElement('div');
      fake.dataset.label = current.name;
      fake.dataset.desc = current.description;
      fake.classList.add('selected');
      showPickerTooltip(fake, modePickerBtn);
    }

    // Delegated hover handling — one listener handles every picker dropdown.
    document.addEventListener('mouseover', (e) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      const item = target.closest('.picker-dropdown-item');
      if (!item) return;
      // Only consider items inside an open dropdown.
      const dropdown = item.closest('.picker-dropdown');
      if (!dropdown || !dropdown.classList.contains('open')) return;
      showPickerTooltip(item, item.closest('.picker-wrap')?.querySelector('.picker-btn'));
    });

    document.addEventListener('mouseout', (e) => {
      const target = e.target;
      const related = e.relatedTarget;
      if (!(target instanceof Element)) return;
      const item = target.closest('.picker-dropdown-item');
      if (!item) return;
      // Stay visible if the mouse moved to another item inside the same dropdown.
      if (related instanceof Element) {
        const nextItem = related.closest('.picker-dropdown-item');
        if (nextItem && nextItem !== item) return;
      }
      hidePickerTooltip();
    });

    // Hide the tooltip when the user scrolls a dropdown so it doesn't drift.
    function attachScrollHide(dropdownEl) {
      if (!dropdownEl || dropdownEl._tooltipScrollAttached) return;
      dropdownEl._tooltipScrollAttached = true;
      dropdownEl.addEventListener('scroll', hidePickerTooltip);
    }
    attachScrollHide(modeDropdown);
    attachScrollHide(modelDropdown);
    // Dynamic configOption dropdowns: rely on the same handler via event-delegation
    // (they exist inside #configOptionsContainer); attach once per dropdown when created.
    if (configOptionsContainer) {
      const mo = new MutationObserver(() => {
        configOptionsContainer.querySelectorAll('.picker-dropdown').forEach(attachScrollHide);
      });
      mo.observe(configOptionsContainer, { childList: true, subtree: true });
    }

    // Close pickers when clicking outside
    document.addEventListener('click', (e) => {
      const target = e.target;
      if (target instanceof Element && target.closest('.picker-wrap')) return;
      closePickers();
    });

    window.addEventListener('resize', () => closePickers());

    // --- Messages ---
    function addMessage(role, text, attachmentNote) {
      chatHistory.push({ kind: 'message', role, text, attachmentNote: attachmentNote || '' });
      saveState();
      return addMessageDOM(role, text, attachmentNote);
    }

    function addMessageDOM(role, text, attachmentNote) {
      hideEmpty();
      const el = document.createElement('div');
      el.className = 'message ' + role;
      if (role === 'user' && attachmentNote) {
        el.textContent = text;
        const pill = document.createElement('div');
        pill.innerHTML = '<span class="attachment-pill">' + escapeHtml(attachmentNote) + '</span>';
        el.appendChild(pill.firstChild);
      } else {
        el.textContent = text;
      }
      messagesEl.appendChild(el);
      scrollToBottom();
      return el;
    }

    function hideEmpty() {
      if (emptyState) emptyState.style.display = 'none';
      if (sessionHome) sessionHome.style.display = 'none';
    }

    function scrollToBottom() {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function getStatusIcon(status) {
      switch (status) {
        case 'running': return '⟳';
        case 'completed': return '✓';
        case 'failed': return '✗';
        default: return '…';
      }
    }

    function getStatusLabel(status) {
      switch (status) {
        case 'running': return 'running…';
        case 'completed': return '✓ done';
        case 'failed': return '✗ failed';
        default: return status || 'pending';
      }
    }

    // Create a new turn container with agent label
    function createTurnEl() {
      const el = document.createElement('div');
      el.className = 'turn';
      const labelEl = document.createElement('div');
      labelEl.className = 'turn-agent-label';
      const agentName = sessionState ? (sessionState.agentName || '') : '';
      labelEl.innerHTML = '<span class="al-dot"></span>' + (agentName ? escapeHtml(agentName) : '');
      el.appendChild(labelEl);
      messagesEl.appendChild(el);
      hideEmpty();
      return el;
    }

    // Ensure the current turn has a tools container
    function ensureTurnTools() {
      if (!currentTurnEl) {
        // Create turn container if none (e.g., tool call before first text)
        currentTurnEl = createTurnEl();
      }
      if (!currentToolsListEl) {
        const toolsWrap = document.createElement('div');
        toolsWrap.className = 'turn-tools';

        currentToolCount = 0;
        const summary = document.createElement('div');
        summary.className = 'turn-tools-summary';
        summary.textContent = '▸ Tool calls';
        currentToolsCountEl = summary;
        summary.addEventListener('click', () => {
          const list = summary.nextElementSibling;
          if (list) {
            const count = parseInt(summary.dataset.count || '0', 10);
            const collapsed = list.classList.toggle('collapsed');
            summary.textContent = (collapsed ? '▸ ' : '▾ ') + count + ' tool call' + (count !== 1 ? 's' : '');
          }
        });
        toolsWrap.appendChild(summary);

        const list = document.createElement('div');
        list.className = 'turn-tools-list';
        toolsWrap.appendChild(list);
        currentToolsListEl = list;

        currentTurnEl.appendChild(toolsWrap);
      }
    }

    function addToolCall(toolCallId, title, status, kind, content, locations) {
      chatHistory.push({ kind: 'toolCall', toolCallId, title, status, toolKind: kind, content, locations });
      saveState();
      addToolCallInline(toolCallId, title, status, kind, content, locations);
    }

    function getToolIcon(kind, title) {
      if (kind) {
        const kindIcons = {
          read: '📂', edit: '✏️', delete: '🗑️', move: '📦',
          search: '🔍', execute: '▶️', think: '💭', fetch: '🌐',
          switch_mode: '⚙️',
        };
        if (kindIcons[kind]) return kindIcons[kind];
      }
      const t = (title || '').toLowerCase();
      if (t.includes('read')) return '📂';
      if (t.includes('grep') || t.includes('search')) return '🔍';
      if (t.includes('edit') || t.includes('write')) return '✏️';
      if (t.includes('terminal') || t.includes('run')) return '▶️';
      return '🔧';
    }

    function parseToolTitle(title) {
      const raw = title || 'Tool Call';
      const space = raw.indexOf(' ');
      if (space > 0) {
        return '<em>' + escapeHtml(raw.slice(0, space)) + '</em> ' + escapeHtml(raw.slice(space + 1));
      }
      return '<em>' + escapeHtml(raw) + '</em>';
    }

    // LCS-based line diff (capped at MAX lines to bound O(N*M) cost)
    function computeLineDiff(oldLines, newLines) {
      const MAX = 200;
      const a = oldLines.slice(0, MAX), b = newLines.slice(0, MAX);
      const m = a.length, n = b.length;
      const dp = [];
      for (let i = 0; i <= m; i++) { dp[i] = new Array(n + 1).fill(0); }
      for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
          dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] + 1 : Math.max(dp[i-1][j], dp[i][j-1]);
        }
      }
      const result = [];
      let i = m, j = n;
      while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && a[i-1] === b[j-1]) {
          result.unshift({ type: 'ctx', text: a[i-1] });
          i--; j--;
        } else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) {
          result.unshift({ type: 'add', text: b[j-1] });
          j--;
        } else {
          result.unshift({ type: 'del', text: a[i-1] });
          i--;
        }
      }
      return result;
    }

    function buildDiffHtml(diffContent) {
      const path = diffContent.path || '';
      const oldLines = (diffContent.oldText || '').split('\n');
      const newLines = (diffContent.newText || '').split('\n');
      const lines = diffContent.oldText != null
        ? computeLineDiff(oldLines, newLines)
        : newLines.map(t => ({ type: 'add', text: t }));
      const lineHtml = lines.slice(0, 400).map(l => {
        const cls = l.type === 'add' ? 'add' : l.type === 'del' ? 'del' : 'ctx';
        const prefix = l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ';
        return '<div class="tr-diff-line ' + cls + '"><span>' + prefix + ' ' + escapeHtml(l.text) + '</span></div>';
      }).join('');
      return '<div class="tr-diff">'
           + '<div class="tr-diff-path">' + escapeHtml(path) + '</div>'
           + '<div class="tr-diff-lines">' + lineHtml + '</div>'
           + '</div>';
    }

    function buildContentHtml(contentArr) {
      if (!contentArr || !contentArr.length) return '';
      let html = '';
      for (const c of contentArr) {
        if (c.type === 'diff') {
          html += buildDiffHtml(c);
        } else if (c.type === 'content') {
          const block = c.content;
          if (block && block.type === 'text' && block.text) {
            html += '<div class="tr-text-out">' + escapeHtml(block.text) + '</div>';
          }
        } else if (c.type === 'terminal') {
          html += '<div class="tr-text-out" style="opacity:0.6">Terminal: ' + escapeHtml(c.terminalId || '') + '</div>';
        }
      }
      return html;
    }

    function buildToolRowHtml(toolCallId, title, status, kind, content, locations) {
      let locHtml = '';
      if (locations && locations.length) {
        const chips = locations.slice(0, 6).map(loc => {
          const label = loc.line != null ? loc.path + ':' + loc.line : loc.path;
          return '<span class="tr-loc" title="' + escapeHtml(label) + '">' + escapeHtml(label) + '</span>';
        }).join('');
        locHtml = '<div class="tr-locations">' + chips + '</div>';
      }
      const inner = buildContentHtml(content);
      const bodyHtml = inner
        ? '<div class="tr-body"><span class="tr-body-toggle">▸ Output</span><div class="tr-body-content">' + inner + '</div></div>'
        : '';
      return '<span class="tr-icon">' + getToolIcon(kind, title) + '</span>'
           + '<span class="tr-name">' + parseToolTitle(title) + '</span>'
           + '<span class="tr-status ' + status + '">' + getStatusLabel(status) + '</span>'
           + locHtml + bodyHtml;
    }

    function attachBodyToggle(el) {
      el.addEventListener('click', e => {
        const btn = e.target.closest('.tr-body-toggle');
        if (!btn) return;
        const body = btn.nextElementSibling;
        if (!body) return;
        const open = body.classList.toggle('open');
        btn.textContent = (open ? '▾' : '▸') + ' Output';
      });
    }

    function addToolCallInline(toolCallId, title, status, kind, content, locations) {
      hideEmpty();
      if (!currentTurnEl) currentTurnEl = createTurnEl();

      const el = document.createElement('div');
      el.className = 'tool-row';
      el.id = 'tc-' + toolCallId;
      el.innerHTML = buildToolRowHtml(toolCallId, title, status, kind, content, locations);
      attachBodyToggle(el);
      currentTurnEl.appendChild(el);
      toolCalls[toolCallId] = el;
      scrollToBottom();
    }

    // DOM builder for history restore
    function addToolCallDOM(toolCallId, title, status, kind, content, locations) {
      hideEmpty();
      const el = document.createElement('div');
      el.className = 'tool-row';
      el.id = 'tc-' + toolCallId;
      el.innerHTML = buildToolRowHtml(toolCallId, title, status, kind, content, locations);
      attachBodyToggle(el);
      messagesEl.appendChild(el);
      toolCalls[toolCallId] = el;
      scrollToBottom();
    }

    function updateToolCall(toolCallId, status, title, content, locations) {
      for (let i = chatHistory.length - 1; i >= 0; i--) {
        if (chatHistory[i].kind === 'toolCall' && chatHistory[i].toolCallId === toolCallId) {
          chatHistory[i].status = status;
          if (title) chatHistory[i].title = title;
          if (content) chatHistory[i].content = content;
          if (locations) chatHistory[i].locations = locations;
          break;
        }
      }
      saveState();

      const el = toolCalls[toolCallId] || document.getElementById('tc-' + toolCallId);
      if (!el) return;

      const statusEl = el.querySelector('.tr-status');
      if (statusEl) {
        statusEl.className = 'tr-status ' + status;
        statusEl.textContent = getStatusLabel(status);
        if (title) {
          const titleEl = el.querySelector('.tr-name');
          if (titleEl) titleEl.innerHTML = parseToolTitle(title);
        }
      }

      if (locations && locations.length) {
        let locEl = el.querySelector('.tr-locations');
        if (!locEl) {
          locEl = document.createElement('div');
          locEl.className = 'tr-locations';
          el.appendChild(locEl);
        }
        locEl.innerHTML = locations.slice(0, 6).map(loc => {
          const label = loc.line != null ? loc.path + ':' + loc.line : loc.path;
          return '<span class="tr-loc" title="' + escapeHtml(label) + '">' + escapeHtml(label) + '</span>';
        }).join('');
      }

      if (content && content.length) {
        const inner = buildContentHtml(content);
        if (inner) {
          let bodyEl = el.querySelector('.tr-body');
          if (!bodyEl) {
            bodyEl = document.createElement('div');
            bodyEl.className = 'tr-body';
            bodyEl.innerHTML = '<span class="tr-body-toggle">▸ Output</span><div class="tr-body-content">' + inner + '</div>';
            attachBodyToggle(bodyEl);
            el.appendChild(bodyEl);
          } else {
            const contentEl = bodyEl.querySelector('.tr-body-content');
            if (contentEl) contentEl.innerHTML = inner;
          }
        }
      }

      // Legacy card style fallback
      const badge = el.querySelector('.status-badge');
      if (badge) { badge.className = 'status-badge ' + status; badge.textContent = status; }
      if (title) { const t = el.querySelector('.title'); if (t) t.textContent = title; }
    }

    function addPlan(plan) {
      chatHistory.push({ kind: 'plan', plan: plan });
      saveState();
      addPlanDOM(plan);
    }

    function addPlanDOM(plan) {
      hideEmpty();
      const el = document.createElement('div');
      el.className = 'plan';
      let html = '<div class="plan-title">Plan</div>';
      if (plan.entries) {
        for (const entry of plan.entries) {
          const icon = entry.status === 'completed' ? '✅'
            : entry.status === 'in_progress' ? '🔄' : '⬜';
          const cls = entry.status === 'completed' ? ' completed' : '';
          html += '<div class="plan-entry' + cls + '">'
            + icon + ' ' + escapeHtml(entry.title || entry.description || entry.content || '')
            + '</div>';
        }
      }
      el.innerHTML = html;
      messagesEl.appendChild(el);
      scrollToBottom();
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    function finalizeThought() {
      if (!currentThoughtEl) return;
      if (thoughtEndTime) return; // already finalized
      thoughtEndTime = Date.now();
      currentThoughtEl.classList.remove('streaming');
      const elapsed = thoughtStartTime ? Math.round((thoughtEndTime - thoughtStartTime) / 1000) : 0;
      const summary = currentThoughtEl.querySelector('summary');
      if (summary) {
        const label = elapsed > 0 ? 'Thought' : 'Thought';
        const timeStr = elapsed > 0 ? elapsed + 's' : '';
        summary.innerHTML =
          '<span class="th-label">' + label + '</span>' +
          (timeStr ? '<span class="th-time">' + timeStr + '</span>' : '');
      }
    }

    /**
     * Commit the in-progress assistant turn to chatHistory (without firing
     * the live promptEnd markdown-render request — replay does that
     * batched at loadSessionEnd). Resets all per-turn DOM/state pointers so
     * the next turn starts fresh.
     */
    function finalizeCurrentAssistantTurn() {
      if (currentThoughtText) {
        finalizeThought();
        const tEnd = thoughtEndTime || Date.now();
        chatHistory.push({
          kind: 'thought',
          text: currentThoughtText,
          durationSec: thoughtStartTime ? Math.round((tEnd - thoughtStartTime) / 1000) : 0,
        });
      }
      if (currentAssistantText) {
        chatHistory.push({ kind: 'message', role: 'assistant', text: currentAssistantText });
        saveState();
      }
      currentAssistantEl = null;
      currentAssistantText = '';
      currentTurnEl = null;
      currentToolsListEl = null;
      currentToolsCountEl = null;
      currentToolCount = 0;
      currentThoughtEl = null;
      currentThoughtTextEl = null;
      currentThoughtText = '';
      thoughtStartTime = null;
      thoughtEndTime = null;
    }

    function addThoughtDOM(text, durationSec) {
      hideEmpty();
      const el = document.createElement('details');
      el.className = 'thought-block';
      el.innerHTML =
        '<summary>' +
        '<span class="th-label">Thought</span>' +
        (durationSec > 0 ? '<span class="th-time">' + durationSec + 's</span>' : '') +
        '</summary>' +
        '<div class="thought-content">' + escapeHtml(text) + '</div>';
      messagesEl.appendChild(el);
      scrollToBottom();
    }

    function showSessionConnected(session) {
      hasActiveSession = true;
      sessionState = {
        agentName: session.agentName,
        cwd: session.cwd,
        title: session.title || undefined,
        sessionId: session.sessionId,
      };
      saveState();

      // Ensure a tab exists for this session
      ensureTab(session.sessionId || ('sess-' + Date.now()), session.agentName,
        session.title || '');

      showSessionConnectedFromState(sessionState);

      // Prefer ACP "Session Config Options" when provided.
      const cfg = session.configOptions;
      if (Array.isArray(cfg) && cfg.length > 0) {
        setConfigOptionsState(cfg);
      } else {
        setConfigOptionsState([]);
        if (session.modes) updateModePicker(session.modes);
        if (session.models) updateModelPicker(session.models);
      }
      if (session.availableCommands) {
        availableCommands = session.availableCommands;
      }
      updatePlaceholder();
      updateModeLabel();
    }

    function showSessionConnectedFromState(ss) {
      hasActiveSession = true;
      hideEmpty();
      // Show skill shortcuts when chat is empty
      if (sessionHome && chatHistory.length === 0) {
        sessionHome.style.display = '';
      }
      // Update connected banner
      if (sessionBanner) sessionBanner.classList.add('visible');
      if (bannerAgent) bannerAgent.textContent = ss.agentName || '';
      if (bannerCwd) bannerCwd.textContent = ss.cwd || '';
      if (inputArea) inputArea.classList.remove('disabled');
      promptInput.disabled = false;
    }

    function showNoSession() {
      hasActiveSession = false;
      sessionState = null;
      saveState();
      if (sessionBanner) sessionBanner.classList.remove('visible');
      if (emptyState) emptyState.style.display = '';
      renderAgentCards(configuredAgents);
      if (inputArea) inputArea.classList.remove('disabled');
      promptInput.disabled = false;
      modePickerWrap.classList.add('hidden');
      modelPickerWrap.classList.add('hidden');
      setConfigOptionsState([]);
      updatePlaceholder();
    }

    // Handle messages from the extension
    window.addEventListener('message', (event) => {
      const msg = event.data;
      switch (msg.type) {
        case 'authState':
          applyAuthState(msg);
          break;

        case 'quchiAuthState':
          dbg('recv quchiAuthState userCode=' + (msg.state && msg.state.userCode));
          quchiAuth = msg.state;
          renderQuchiDeviceState(quchiAuth);
          scheduleQuchiPoll();
          setLoginBusy(false);
          if (loginBusyTimer) { clearTimeout(loginBusyTimer); loginBusyTimer = null; }
          if (quchiAuth && quchiAuth.loggedIn) applyAuthState({ loggedIn: true, quchi: quchiAuth });
          break;

        case 'authError':
          dbg('recv authError: ' + (msg.message || ''));
          showLoginError(msg.message || 'Quchi 登录失败。');
          setLoginBusy(false);
          if (loginBusyTimer) { clearTimeout(loginBusyTimer); loginBusyTimer = null; }
          break;

        case 'state':
          if (msg.platform === 'darwin') {
            attachHint = '⌘ Esc to attach selected text';
          } else if (msg.platform === 'win32') {
            attachHint = 'Ctrl Esc to attach selected text';
          } else {
            attachHint = 'Esc to attach selected text';
          }
          if (Array.isArray(msg.agents)) {
            configuredAgents = msg.agents;
            renderAgentCards(configuredAgents);
          }
          if (Array.isArray(msg.history)) {
            sessionHistory = msg.history;
            if (historyBadgeWrap) historyBadgeWrap.classList.toggle('has-history', sessionHistory.length > 0);
          }
          updatePlaceholder();
          if (msg.session) {
            showSessionConnected(msg.session);
          } else {
            showNoSession();
          }
          break;

        case 'file-attached':
          if (msg.name && msg.path) {
            attachedFiles.push({ name: msg.name, path: msg.path });
            renderAttachPills();
          }
          break;

        case 'selectionUpdate':
          pendingSelectionText = msg.text || '';
          updateSelectionBadge(msg.lines || 0);
          break;

        case 'promptStart':
          setProcessing(true);
          removeStreamingCursor();
          currentAssistantEl = null;
          currentAssistantText = '';
          currentTurnEl = null;
          currentToolsListEl = null;
          currentToolsCountEl = null;
          currentToolCount = 0;
          currentThoughtEl = null;
          currentThoughtTextEl = null;
          currentThoughtText = '';
          thoughtStartTime = null;
          thoughtEndTime = null;
          break;

        case 'promptEnd': {
          // Finalize thought block if present — must happen before push to chatHistory
          if (currentThoughtText) {
            finalizeThought();
            const tEnd = thoughtEndTime || Date.now();
            chatHistory.push({
              kind: 'thought',
              text: currentThoughtText,
              durationSec: thoughtStartTime ? Math.round((tEnd - thoughtStartTime) / 1000) : 0,
            });
          }
          if (currentAssistantText) {
            chatHistory.push({ kind: 'message', role: 'assistant', text: currentAssistantText });
            saveState();
            // Request markdown rendering from extension host
            if (currentAssistantEl) {
              vscode.postMessage({
                type: 'renderMarkdown',
                items: [{ index: chatHistory.length - 1, text: currentAssistantText }]
              });
            }
          }
          // Persist the complete turn (user + tools + thought + assistant) to
          // workspaceState so the conversation survives VS Code restarts.
          if (sessionState && sessionState.sessionId) {
            vscode.postMessage({
              type: 'persistMessages',
              sessionId: sessionState.sessionId,
              agentName: sessionState.agentName || '',
              messages: chatHistory,
            });
          }
          setProcessing(false);
          removeStreamingCursor();
          currentAssistantEl = null;
          currentAssistantText = '';
          // Auto-collapse tool calls in completed turns
          if (currentToolsListEl && currentToolCount > 3) {
            currentToolsListEl.classList.add('collapsed');
            if (currentToolsCountEl) {
              currentToolsCountEl.dataset.count = String(currentToolCount);
              currentToolsCountEl.textContent = '▸ ' + currentToolCount + ' tool calls';
            }
          }
          currentTurnEl = null;
          currentToolsListEl = null;
          currentToolsCountEl = null;
          currentToolCount = 0;
          currentThoughtEl = null;
          currentThoughtTextEl = null;
          currentThoughtText = '';
          thoughtStartTime = null;
          thoughtEndTime = null;
          break;
        }

        case 'clearChat':
          chatHistory = [];
          sessionState = null;
          saveState();
          currentAssistantEl = null;
          currentAssistantText = '';
          toolCalls = {};
          currentTurnEl = null;
          currentToolsListEl = null;
          currentToolsCountEl = null;
          currentToolCount = 0;
          currentThoughtEl = null;
          currentThoughtTextEl = null;
          currentThoughtText = '';
          thoughtStartTime = null;
          thoughtEndTime = null;
          availableCommands = [];
          slashPopup.classList.remove('open');
          messagesEl.innerHTML = '';
          messagesEl.appendChild(emptyState);
          if (emptyState) emptyState.style.display = '';
          if (sessionHome) { messagesEl.appendChild(sessionHome); sessionHome.style.display = 'none'; }
          if (inputArea) inputArea.classList.add('disabled');
          modePickerWrap.classList.add('hidden');
          modelPickerWrap.classList.add('hidden');
          setConfigOptionsState([]);
          setProcessing(false);
          break;

        case 'error':
          addMessage('error', msg.message || 'An error occurred');
          break;

        case 'sessionUpdate':
          handleUpdate(msg.update);
          break;

        case 'modesUpdate':
          updateModePicker(msg.modes);
          break;

        case 'modelsUpdate':
          updateModelPicker(msg.models);
          break;

        case 'configOptionsUpdate':
          setConfigOptionsState(msg.configOptions || []);
          break;

        case 'loadSessionStart':
          handleLoadSessionStart();
          break;

        case 'loadSessionEnd':
          handleLoadSessionEnd(!!msg.ok);
          break;

        case 'sessionInfoUpdate':
          handleSessionInfoUpdate(msg.title);
          break;

        case 'restoreMessages':
          handleRestoreMessages(msg);
          break;

        case 'markdownRendered': {
          // Extension sent back rendered HTML for messages
          const rendered = msg.items || [];
          for (const item of rendered) {
            // Find the DOM element for this history item
            // For the just-completed streaming message, update the last assistant el
            const historyItem = chatHistory[item.index];
            if (!historyItem || historyItem.role !== 'assistant') continue;

            // Find the element — walk all .message.assistant elements
            const allAssistant = messagesEl.querySelectorAll('.message.assistant');
            // The item.index tracks position in chatHistory; count only assistant messages up to this index
            let assistantIdx = 0;
            for (let i = 0; i < chatHistory.length; i++) {
              if (i === item.index) break;
              if (chatHistory[i].kind === 'message' && chatHistory[i].role === 'assistant') assistantIdx++;
            }
            const el = allAssistant[assistantIdx];
            if (el) {
              el.classList.add('md-rendered');
              el.innerHTML = item.html;
            }
          }
          scrollToBottom();
          break;
        }
      }
    });

    function handleUpdate(update) {
      if (!update) return;
      const type = update.sessionUpdate;

      switch (type) {
        case 'agent_message_chunk': {
          const content = update.content;
          if (content && content.type === 'text' && content.text) {
            currentAssistantText += content.text;
            // Don't create visible element until there's non-whitespace content
            if (!currentAssistantEl && !currentAssistantText.trim()) {
              break;
            }
            // Auto-collapse thought when assistant text starts
            if (currentThoughtEl && currentThoughtEl.open) {
              finalizeThought();
              currentThoughtEl.open = false;
            }
            if (!currentAssistantEl) {
              if (!currentTurnEl) {
                currentTurnEl = createTurnEl();
              }
              currentAssistantEl = document.createElement('div');
              currentAssistantEl.className = 'message assistant';
              const toolsEl = currentTurnEl.querySelector('.turn-tools');
              currentTurnEl.insertBefore(currentAssistantEl, toolsEl || null);
            }
            updateStreamingAssistantText();
            scrollToBottom();
          }
          break;
        }

        case 'user_message_chunk': {
          // Only the session/load replay path emits this; live prompts
          // never echo the user's message. Use it to break apart historical
          // turns: finalize any pending assistant turn first, then append
          // the historical user message.
          const content = update.content;
          if (content && content.type === 'text' && typeof content.text === 'string') {
            finalizeCurrentAssistantTurn();
            // Coalesce consecutive user chunks into one message.
            const last = chatHistory[chatHistory.length - 1];
            if (last && last.kind === 'message' && last.role === 'user') {
              last.text += content.text;
              const allUser = messagesEl.querySelectorAll('.message.user');
              const el = allUser[allUser.length - 1];
              if (el) el.textContent = last.text;
            } else {
              addMessage('user', content.text);
            }
          }
          break;
        }

        case 'agent_thought_chunk': {
          const content = update.content;
          if (content && content.type === 'text') {
            if (!currentThoughtEl) {
              // Create thought block inside turn
              if (!currentTurnEl) {
                currentTurnEl = createTurnEl();
              }
              currentThoughtEl = document.createElement('details');
              currentThoughtEl.className = 'thought-block streaming';
              currentThoughtEl.open = true;
              currentThoughtEl.innerHTML =
                '<summary>' +
                '<span class="thought-indicator"></span>' +
                '<span class="th-label">Thinking\u2026</span>' +
                '</summary>' +
                '<div class="thought-content"></div>';
              currentThoughtTextEl = currentThoughtEl.querySelector('.thought-content');
              currentTurnEl.insertBefore(currentThoughtEl, currentTurnEl.firstChild);
              thoughtStartTime = Date.now();
              currentThoughtText = '';
            }
            currentThoughtText += content.text;
            currentThoughtTextEl.textContent = currentThoughtText;
            scrollToBottom();
          }
          break;
        }

        case 'tool_call': {
          const tc = update;
          addToolCall(
            tc.toolCallId || 'unknown',
            tc.title || 'Tool Call',
            tc.status || 'pending',
            tc.kind || null,
            tc.content || null,
            tc.locations || null,
          );
          break;
        }

        case 'tool_call_update': {
          updateToolCall(
            update.toolCallId || 'unknown',
            update.status || 'completed',
            update.title,
            update.content || null,
            update.locations || null,
          );
          break;
        }

        case 'plan': {
          addPlan(update);
          break;
        }

        case 'current_mode_update': {
          // Server pushed a mode change
          currentModeId = update.currentModeId || update.modeId || null;
          const current = availableModes.find(m => m.id === currentModeId);
          if (current) {
            modePickerLabel.textContent = current.name;
            renderModeDropdown();
          }
          break;
        }

        case 'config_option_update': {
          // Server pushed a full configOptions replacement
          setConfigOptionsState(update.configOptions || []);
          break;
        }

        case 'available_commands_update':
          availableCommands = update.availableCommands || [];
          updatePlaceholder();
          break;
      }
    }

    // Restore previous state before telling extension we're ready
    restoreState();

    window.addEventListener('error', (ev) => {
      dbg('window.error: ' + (ev.message || ev.error));
    });

    // Tell extension we're ready
    dbg('posting ready');
    vscode.postMessage({ type: 'ready' });
    dbg('script init done');
  </script>
</body>
</html>`;
  }

  /**
   * Attach a file URI — notify the webview to include it in the next prompt.
   */
  attachFile(uri: vscode.Uri): void {
    if (this.view) {
      this.view.webview.postMessage({
        type: 'file-attached',
        path: uri.fsPath,
        name: uri.fsPath.split(/[\\/]/).pop() || uri.fsPath,
      });
      this.view.show?.(true);
    }
  }

  dispose(): void {
    this.sessionUpdateHandler.removeListener(this.updateListener);
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
