import { Workspace, WorkspaceEmit } from './workspace';

export class WorkspaceManager {
  private workspaces = new Map<string, Workspace>();
  private order: string[] = [];
  private seq = 0;
  private emit: WorkspaceEmit;

  constructor(emit: WorkspaceEmit) {
    this.emit = emit;
  }

  create(rootPath: string | null): Workspace {
    this.seq += 1;
    const id = `ws-${this.seq}`;
    const name = rootPath ? rootPath.split(/[\\/]/).pop() ?? `Workspace ${this.seq}` : `Workspace ${this.seq}`;
    const ws = new Workspace(id, name, rootPath, this.emit);
    this.workspaces.set(id, ws);
    this.order.push(id);
    return ws;
  }

  get(id: string) {
    return this.workspaces.get(id);
  }

  list(): Workspace[] {
    return this.order.map((id) => this.workspaces.get(id)!).filter(Boolean);
  }

  close(id: string) {
    const ws = this.workspaces.get(id);
    if (!ws) return;
    ws.dispose();
    this.workspaces.delete(id);
    this.order = this.order.filter((x) => x !== id);
  }

  disposeAll() {
    for (const ws of this.workspaces.values()) ws.dispose();
    this.workspaces.clear();
    this.order = [];
  }
}
