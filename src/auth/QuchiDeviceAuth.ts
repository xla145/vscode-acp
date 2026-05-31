import type { QuchiAuthState } from '../core/SessionManager';
import { logAuth } from '../utils/Logger';
import { pollQuchiDeviceToken, requestQuchiDeviceCode } from './quchiHttp';
import { QuchiTokenStore, type QuchiToken } from './QuchiTokenStore';
import { getQuchiStatePath } from './QuchiTokenStore';

/**
 * Quchi device-code login without spawning fastopc / ACP.
 * Persists tokens to the same file fastopc reads so ACP connect works after login.
 */
export class QuchiDeviceAuth {
  private readonly store: QuchiTokenStore;

  constructor(store = new QuchiTokenStore()) {
    this.store = store;
  }

  /** Fingerprint of on-disk state; used to detect TUI/CLI login without re-reading UI. */
  getStoreSignature(): string {
    const persisted = this.store.load();
    const token = persisted.token;
    return [
      token?.accessToken ?? '',
      token?.refreshToken ?? '',
      String(persisted.obtainedAt ?? ''),
      persisted.selectedModelId ?? '',
    ].join('|');
  }

  refreshFromStore(): QuchiAuthState {
    const persisted = this.store.load();
    const token = persisted.token;
    const loggedIn = Boolean(token?.accessToken);
    return {
      loggedIn,
      pending: false,
      selectedModelId: persisted.selectedModelId ?? 'standard',
    };
  }

  async startDeviceFlow(): Promise<QuchiAuthState> {
    logAuth('startDeviceFlow', { statePath: getQuchiStatePath() });
    const device = await requestQuchiDeviceCode();
    if (!device.deviceCode || !device.userCode) {
      throw new Error('Quchi 未返回有效授权码，请检查网络或 client 配置。');
    }
    const verificationUri = `https://www.quchiai.com/activate?user_code=${encodeURIComponent(device.userCode)}`;
    return {
      loggedIn: false,
      pending: true,
      deviceCode: device.deviceCode,
      userCode: device.userCode,
      verificationUri,
      interval: device.interval,
      expiresIn: device.expiresIn,
    };
  }

  async pollDeviceFlow(deviceCode: string): Promise<QuchiAuthState> {
    const raw = await pollQuchiDeviceToken(deviceCode);
    if (!raw) {
      return { loggedIn: false, pending: true, deviceCode };
    }
    const token: QuchiToken = {
      accessToken: raw.accessToken,
      refreshToken: raw.refreshToken,
      expiresIn: raw.expiresIn,
    };
    if (!token.accessToken) {
      return { loggedIn: false, pending: true, deviceCode, error: '授权未完成，请在浏览器完成登录。' };
    }
    this.store.saveToken(token);
    const persisted = this.store.load();
    return {
      loggedIn: true,
      pending: false,
      deviceCode,
      selectedModelId: persisted.selectedModelId ?? 'standard',
    };
  }

  signOut(): void {
    this.store.clearToken();
  }
}
