import { Workspace } from './workspace';
import { Project, type ProjectEmit, type ProjectWorkspaceLink } from './project';
import type { WorkspaceKind, WorkspaceType } from './ipc-channels';

/**
 * Owns every open Workspace, each of which owns its own Projects. Project ids
 * are minted from a SINGLE global sequence here (never per-workspace), which
 * is the trick that keeps the rest of the app simple: any existing IPC
 * channel that already took a "workspace id" (session list/new/select,
 * fs/terminal/agent/diff/roadmap/scheduler/focus/checkpoints/browser — see
 * ipc-channels.ts) can keep its EXACT existing signature and just resolve
 * that id through findProject() below, without ever needing to know which
 * Workspace a Project lives in first.
 */
export class WorkspaceManager {
  private workspaces = new Map<string, Workspace>();
  private order: string[] = [];
  private workspaceSeq = 0;
  /** Global across every workspace — see the class doc comment above. */
  private projectSeq = 0;
  private emit: ProjectEmit;

  constructor(emit: ProjectEmit) {
    this.emit = emit;
  }

  createWorkspace(type: WorkspaceType, label?: string): Workspace {
    this.workspaceSeq += 1;
    const id = `wksp-${this.workspaceSeq}`;
    const workspace = new Workspace(id, label ?? `Workspace ${this.workspaceSeq}`, type);
    this.workspaces.set(id, workspace);
    this.order.push(id);
    return workspace;
  }

  /**
   * Creates a new Project and registers it under an existing workspace.
   * rootPath is loaded exactly like the pre-restructure "pick a folder" flow
   * did (project.setRoot, which loads/creates that folder's own sessions) if
   * given, or starts one blank session if not (rootPath null — a brand-new,
   * not-yet-pointed-anywhere project, matching the old "blank workspace" tab).
   */
  async addProject(workspaceId: string, rootPath: string | null, kind: WorkspaceKind | null = null): Promise<Project | undefined> {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) return undefined;

    this.projectSeq += 1;
    const id = `ws-${this.projectSeq}`;
    const name = rootPath ? rootPath.split(/[\\/]/).pop() ?? `Project ${this.projectSeq}` : `Project ${this.projectSeq}`;
    const link: ProjectWorkspaceLink = {
      contextStore: workspace.contextStore,
      getMetaFile: () => workspace.metaFile,
      listSiblingProjects: () => workspace.siblingProjectsNote(id),
    };
    const project = new Project(id, name, null, this.emit, link);
    if (kind) project.kind = kind;
    workspace.addProject(project);

    if (rootPath) await project.setRoot(rootPath);
    else project.newSession();

    return project;
  }

  /** Removes a project from its workspace (disposing it) without closing the workspace itself. */
  removeProject(workspaceId: string, projectId: string): Project | undefined {
    return this.workspaces.get(workspaceId)?.removeProject(projectId);
  }

  get(id: string): Workspace | undefined {
    return this.workspaces.get(id);
  }

  list(): Workspace[] {
    return this.order.map((id) => this.workspaces.get(id)!).filter(Boolean);
  }

  /** Resolves a project id to its Project, without needing to know which workspace it lives in first — see the class doc comment. */
  findProject(projectId: string): Project | undefined {
    for (const workspace of this.workspaces.values()) {
      const project = workspace.getProject(projectId);
      if (project) return project;
    }
    return undefined;
  }

  /** The workspace a given project lives in, if any — used to resolve a renderer-facing project id up to its parent workspace (e.g. workspace:set-active). */
  workspaceContaining(projectId: string): Workspace | undefined {
    for (const workspace of this.workspaces.values()) {
      if (workspace.getProject(projectId)) return workspace;
    }
    return undefined;
  }

  close(workspaceId: string) {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) return;
    workspace.dispose();
    this.workspaces.delete(workspaceId);
    this.order = this.order.filter((x) => x !== workspaceId);
  }

  disposeAll() {
    for (const workspace of this.workspaces.values()) workspace.dispose();
    this.workspaces.clear();
    this.order = [];
  }
}
