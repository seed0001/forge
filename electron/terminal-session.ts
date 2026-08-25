import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import type { TermDataEvent } from './ipc-channels';

/**
 * One shell context per workspace. Each workspace keeps its own working
 * directory and its own in-flight child process, so a command running in one
 * workspace is unaffected by anything happening in another.
 */
export class TerminalSession {
  private cwd: string;
  private current: ChildProcessWithoutNullStreams | null = null;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  getCwd() {
    return this.cwd;
  }

  setCwd(next: string) {
    this.cwd = next;
  }

  kill() {
    if (this.current) {
      this.current.kill();
      this.current = null;
    }
  }

  run(
    requestId: string,
    source: 'you' | 'agent',
    command: string,
    emit: (evt: TermDataEvent) => void
  ): Promise<{ exitCode: number; output: string }> {
    return new Promise((resolve) => {
      emit({ requestId, source, kind: 'cmd', text: command });

      const trimmed = command.trim();
      if (trimmed === 'cd' || trimmed.startsWith('cd ')) {
        const target = trimmed.slice(2).trim() || '.';
        this.cwd = path.resolve(this.cwd, target);
        emit({ requestId, source, kind: 'info', text: `cwd -> ${this.cwd}` });
        resolve({ exitCode: 0, output: `cwd -> ${this.cwd}` });
        return;
      }

      let output = '';
      const child = spawn(command, { shell: true, cwd: this.cwd });
      this.current = child;

      child.stdout.on('data', (buf) => {
        const text = buf.toString();
        output += text;
        emit({ requestId, source, kind: 'stdout', text });
      });
      child.stderr.on('data', (buf) => {
        const text = buf.toString();
        output += text;
        emit({ requestId, source, kind: 'stderr', text });
      });
      child.on('close', (code) => {
        this.current = null;
        emit({ requestId, source, kind: 'exit', text: String(code ?? 0) });
        resolve({ exitCode: code ?? 0, output });
      });
      child.on('error', (err) => {
        this.current = null;
        emit({ requestId, source, kind: 'stderr', text: String(err) });
        emit({ requestId, source, kind: 'exit', text: '1' });
        resolve({ exitCode: 1, output: String(err) });
      });
    });
  }
}
