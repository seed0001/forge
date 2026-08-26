import path from 'node:path';
import { ContextStore } from './context-store';
import { Project } from './project';
import type { WorkspaceSummary, WorkspaceType } from './ipc-channels';

/**
 * The new top-level container inserted above Project: a renameable, typed
 * group of Projects, plus a workspace-wide free-text meta-file (a
 * PROJECT.md-like note for the whole workspace — there's no folder to put a
 * real file in, so it's just a persisted string) and a workspace-scoped
 * ContextStore (durable knowledge shared across every project in it, see
 * context-store.ts's ContextScope). `type` is required at creation and never
 * changes after — a fine simplification for now.
 *
 * A Workspace never runs anything itself — all the actual work (sessions,
 * terminal, diffs, the agent loop) still happens inside each Project. This
 * class only owns the grouping, naming, and workspace-wide memory.
 */
export class Workspace {
  readonly id: string;
  label: string;
  readonly type: WorkspaceType;
  /** Free-text workspace-wide notes, injected into every project's agent turns — see agent-service.ts's WorkspaceContext. */
  metaFile = '';
  /** This workspace's own durable knowledge base, distinct from any project's — see context-store.ts. */
  readonly contextStore: ContextStore;

  private projects = new Map<string, Project>();
  /** Ordered project ids — the order Projects were added in, not alphabetical or anything derived. */
  private order: string[] = [];
  activeProjectId: string | null = null;

  constructor(id: string, label: string, type: WorkspaceType) {
    this.id = id;
    this.label = label;
    this.type = type;
    this.contextStore = new ContextStore({ kind: 'workspace', id });
  }

  /** Registers an already-constructed Project under this workspace — WorkspaceManager.addProject is the only real caller. */
  addProject(project: Project) {
    this.projects.set(project.id, project);
    this.order.push(project.id);
    if (!this.activeProjectId) this.activeProjectId = project.id;
  }

  /** Disposes and removes a project from this workspace. Picks a new active project (the first remaining one) if the removed one was active. */
  removeProject(projectId: string): Project | undefined {
    const project = this.projects.get(projectId);
    if (!project) return undefined;
    project.dispose();
    this.projects.delete(projectId);
    this.order = this.order.filter((id) => id !== projectId);
    if (this.activeProjectId === projectId) this.activeProjectId = this.order[0] ?? null;
    return project;
  }

  getProject(projectId: string): Project | undefined {
    return this.projects.get(projectId);
  }

  /** Every project in this workspace, in the order they were added. */
  listProjects(): Project[] {
    return this.order.map((id) => this.projects.get(id)!).filter(Boolean);
  }

  get activeProject(): Project | undefined {
    return this.activeProjectId ? this.projects.get(this.activeProjectId) : undefined;
  }

  setActiveProject(projectId: string): boolean {
    if (!this.projects.has(projectId)) return false;
    this.activeProjectId = projectId;
    return true;
  }

  /**
   * A cheap, one-line-per-project listing of every OTHER project in this
   * workspace — name plus its folder's basename if it has one — so an
   * agent working in one project knows its siblings exist without loading
   * their full content. Passed to AgentSession as WorkspaceContext.listSiblingProjects.
   */
  siblingProjectsNote(excludeProjectId: string): string {
    return this.listProjects()
      .filter((p) => p.id !== excludeProjectId)
      .map((p) => `- ${p.name}${p.rootPath ? ` (${path.basename(p.rootPath)})` : ' (no folder yet)'}`)
      .join('\n');
  }

  summary(): WorkspaceSummary {
    return {
      id: this.id,
      label: this.label,
      type: this.type,
      metaFile: this.metaFile,
      activeProjectId: this.activeProjectId,
      projects: this.listProjects().map((p) => p.summary()),
    };
  }

  dispose() {
    for (const project of this.listProjects()) project.dispose();
  }
}
