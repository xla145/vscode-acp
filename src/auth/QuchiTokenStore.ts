import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface QuchiToken {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface PersistedQuchiState {
  token?: QuchiToken;
  obtainedAt?: number;
  selectedModelId?: string;
}

/** Same path as fastopc QuchiTokenStore (~/.fastopc/quchi-state.json). */
export function getQuchiStatePath(): string {
  const home = process.env.FASTOPC_HOME ?? path.join(os.homedir(), '.fastopc');
  return path.join(home, 'quchi-state.json');
}

export class QuchiTokenStore {
  constructor(private readonly filePath = getQuchiStatePath()) {}

  load(): PersistedQuchiState {
    if (!fs.existsSync(this.filePath)) {
      return {};
    }
    try {
      return JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as PersistedQuchiState;
    } catch {
      return {};
    }
  }

  save(next: PersistedQuchiState): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const merged: PersistedQuchiState = { ...this.load(), ...next };
    fs.writeFileSync(this.filePath, JSON.stringify(merged, null, 2), 'utf-8');
    try {
      fs.chmodSync(this.filePath, 0o600);
    } catch {
      /* ignore */
    }
  }

  saveToken(token: QuchiToken): void {
    this.save({ token, obtainedAt: Date.now() });
  }

  clearToken(): void {
    const current = this.load();
    const next: PersistedQuchiState = {};
    if (current.selectedModelId) {
      next.selectedModelId = current.selectedModelId;
    }
    if (next.selectedModelId) {
      this.save(next);
    } else {
      this.clearAll();
    }
  }

  clearAll(): void {
    try {
      fs.unlinkSync(this.filePath);
    } catch {
      /* ignore */
    }
  }
}
