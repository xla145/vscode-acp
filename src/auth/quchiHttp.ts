import { logAuth } from '../utils/Logger';

const DEFAULT_PLATFORM_URL = 'https://www.quchiai.com';
const DEFAULT_CLIENT_ID = 'opc-work';
const DEFAULT_SCOPE = 'api:workspace.read';

export interface QuchiDeviceCodeResult {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  interval: number;
  expiresIn: number;
}

export interface QuchiTokenResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

function getClientSecret(): string {
  return process.env.QUCHI_CLIENT_SECRET ?? 'GObe_gpC-cPgL8opc8gmvonGqM-gma4Jv9gSXepdbsY';
}

function joinUrl(platformUrl: string, path: string): string {
  return `${platformUrl.replace(/\/+$/, '')}${path}`;
}

function unwrapPayload(payload: unknown): Record<string, unknown> {
  if (payload && typeof payload === 'object' && 'data' in payload) {
    const data = (payload as { data?: unknown }).data;
    if (data && typeof data === 'object') {
      return data as Record<string, unknown>;
    }
  }
  return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
}

async function jsonRequest(
  platformUrl: string,
  path: string,
  init: { method?: string; body?: unknown; query?: Record<string, string> },
): Promise<unknown> {
  let url = joinUrl(platformUrl, path);
  if (init.query && Object.keys(init.query).length > 0) {
    url += `?${new URLSearchParams(init.query).toString()}`;
  }

  const headers: Record<string, string> = {};
  let body: string | undefined;
  if (init.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.body);
  }

  const response = await fetch(url, {
    method: init.method ?? 'GET',
    headers,
    body,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Quchi API HTTP ${response.status}: ${text || response.statusText}`);
  }
  if (!text) {
    return undefined;
  }
  return JSON.parse(text) as unknown;
}

export async function requestQuchiDeviceCode(
  scope = DEFAULT_SCOPE,
  platformUrl = DEFAULT_PLATFORM_URL,
): Promise<QuchiDeviceCodeResult> {
  logAuth('HTTP requestDeviceCode start', { platformUrl, scope });
  const payload = await jsonRequest(platformUrl, '/rjgc-api/api-framework/auth/device/code', {
    method: 'POST',
    body: {
      client_id: DEFAULT_CLIENT_ID,
      client_secret: getClientSecret(),
      scope,
    },
  });
  const data = unwrapPayload(payload);
  const result = {
    deviceCode: String(data.device_code ?? ''),
    userCode: String(data.user_code ?? ''),
    verificationUri: String(data.verification_uri ?? ''),
    interval: typeof data.interval === 'number' ? data.interval : 5,
    expiresIn: typeof data.expires_in === 'number' ? data.expires_in : 300,
  };
  logAuth('HTTP requestDeviceCode ok', { userCode: result.userCode, hasDeviceCode: Boolean(result.deviceCode) });
  return result;
}

export async function pollQuchiDeviceToken(
  deviceCode: string,
  platformUrl = DEFAULT_PLATFORM_URL,
): Promise<QuchiTokenResult | null> {
  logAuth('HTTP pollDeviceToken', { deviceCodePrefix: deviceCode.slice(0, 8) });
  const payload = await jsonRequest(platformUrl, '/rjgc-api/api-framework/auth/device/token', {
    method: 'POST',
    query: {
      device_code: deviceCode,
      client_id: DEFAULT_CLIENT_ID,
      client_secret: getClientSecret(),
    },
  });
  const envelope = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  const code = typeof envelope.code === 'number' ? envelope.code : undefined;
  const message = typeof envelope.message === 'string' ? envelope.message : '';

  if (code === 200) {
    const data = unwrapPayload(payload);
    const accessToken = typeof data.access_token === 'string'
      ? data.access_token
      : typeof data.accessToken === 'string'
        ? data.accessToken
        : '';
    const refreshToken = typeof data.refresh_token === 'string'
      ? data.refresh_token
      : typeof data.refreshToken === 'string'
        ? data.refreshToken
        : '';
    const expiresIn = typeof data.expires_in === 'number'
      ? data.expires_in
      : typeof data.expiresIn === 'number'
        ? data.expiresIn
        : 3_600_000;
    return { accessToken, refreshToken, expiresIn };
  }
  if (code === 428 || message === 'authorization_pending') {
    return null;
  }
  if (message === 'expired_token') {
    throw new Error('设备码已过期，请重新登录。');
  }
  if (code === 403 || message === 'access_denied') {
    throw new Error('用户拒绝授权。');
  }
  throw new Error(message || '设备码授权失败。');
}
