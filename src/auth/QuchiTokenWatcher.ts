import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getQuchiStatePath } from './QuchiTokenStore';
import { logError } from '../utils/Logger';

/**
 * Watches ~/.fastopc/quchi-state.json so VS Code stays in sync when TUI / CLI logs in or out.
 */
export class QuchiTokenWatcher implements vscode.Disposable {
  private watcher: fs.FSWatcher | undefined;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(private readonly onChanged: () => void) {
    this.start();
  }

  private start(): void {
    const filePath = getQuchiStatePath();
    const dir = path.dirname(filePath);
    const fileName = path.basename(filePath);

    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* ignore */
    }

    try {
      this.watcher = fs.watch(dir, (_event, changed) => {
        if (changed != null && String(changed) !== fileName) {
          return;
        }
        this.schedule();
      });
    } catch (e) {
      logError('Failed to watch Quchi token file', e);
    }
  }

  private schedule(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      if (!this.disposed) {
        this.onChanged();
      }
    }, 300);
  }

  dispose(): void {
    this.disposed = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.watcher?.close();
  }
}
