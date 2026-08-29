import type {
  FileNode,
  ActivityEvent,
  TermDataEvent,
  PendingDiff,
  Checkpoint,
  ChatMessage,
  ChatImage,
  ProjectSummary,
  ProjectHydration,
  WorkspaceSummary,
  WorkspaceType,
  SessionSummary,
  Autonomy,
  CommandApproval,
  SubagentCommandApproval,
  CatalogModel,
  ChatProvider,
  ReasoningLevel,
  AuditReadResult,
  UpdateStatus,
  PortalStatus,
  ProviderSettings,
  RoadmapItem,
  RoadmapItemStatus,
  WorkspaceKind,
  BrowserNavState,
  PermissionOverrides,
  ApprovalDecision,
  ScheduleSpec,
  ScheduledTask,
  FocusAgentSummary,
  FocusMessage,
  TtsProvider,
  TtsVoice,
} from '../../electron/ipc-channels';

type Unsubscribe = () => void;

export interface ForgeApi {
  workspaces: {
    // Renderer-facing "workspace" = one tab = one Project, exactly as before
    // the workspace/project split — `id` here is a PROJECT id. See
    // ipc-channels.ts's ProjectSummary/WorkspaceSummary doc comments.
    list: () => Promise<ProjectSummary[]>;
    create: (type?: WorkspaceType) => Promise<ProjectSummary>;
    close: (id: string) => Promise<ProjectSummary[]>;
    setRoot: (id: string) => Promise<ProjectSummary | null>;
    hydrate: (id: string) => Promise<ProjectHydration | null>;
    markSeen: (id: string) => Promise<ProjectSummary | null>;
    setAutonomy: (id: string, level: Autonomy) => Promise<ProjectSummary | null>;
    setKind: (id: string, kind: WorkspaceKind) => Promise<ProjectSummary | null>;
    setClipsFolder: (id: string) => Promise<ProjectSummary | null>;
    setActive: (id: string) => Promise<boolean>;
    getInitialActive: () => Promise<string | null>;
    onUpdated: (cb: (summary: ProjectSummary) => void) => Unsubscribe;
  };
  /**
   * The real, new top-level Workspace surface — a renameable, typed group of
   * Projects. Not yet used by any UI control (the sidebar tree / splash /
   * type-picker are a later phase), but fully implemented over IPC.
   */
  workspaceTree: {
    list: () => Promise<WorkspaceSummary[]>;
    rename: (workspaceId: string, label: string) => Promise<WorkspaceSummary | null>;
    setMeta: (workspaceId: string, text: string) => Promise<WorkspaceSummary | null>;
    addProject: (workspaceId: string) => Promise<WorkspaceSummary | null>;
    listProjects: (workspaceId: string) => Promise<ProjectSummary[]>;
    removeProject: (workspaceId: string, projectId: string) => Promise<WorkspaceSummary | null>;
    setActiveProject: (workspaceId: string, projectId: string) => Promise<boolean>;
  };
  sessions: {
    list: (id: string) => Promise<SessionSummary[]>;
    create: (id: string) => Promise<SessionSummary | null>;
    select: (
      id: string,
      sessionId: string
    ) => Promise<{
      chat: ChatMessage[];
      activity: ActivityEvent[];
      summary: ProjectSummary;
      roadmap: RoadmapItem[];
    } | null>;
    remove: (id: string, sessionId: string) => Promise<SessionSummary[]>;
    onUpdated: (cb: (workspaceId: string, sessions: SessionSummary[]) => void) => Unsubscribe;
  };
  fs: {
    listDir: (workspaceId: string, dirPath: string) => Promise<FileNode[]>;
    listTree: (id: string) => Promise<FileNode[]>;
    readFile: (workspaceId: string, filePath: string) => Promise<string>;
    writeFile: (id: string, filePath: string, content: string) => Promise<boolean>;
    openInBrowser: (filePath: string) => Promise<boolean>;
  };
  terminal: {
    run: (id: string, command: string) => Promise<{ exitCode: number; output: string }>;
    kill: (id: string) => Promise<boolean>;
    onData: (cb: (workspaceId: string, evt: TermDataEvent) => void) => Unsubscribe;
  };
  agent: {
    send: (id: string, text: string, images?: ChatImage[]) => Promise<boolean>;
    stop: (id: string) => Promise<boolean>;
    onActivity: (cb: (workspaceId: string, sessionId: string, evt: ActivityEvent) => void) => Unsubscribe;
    onMessage: (cb: (workspaceId: string, sessionId: string, msg: ChatMessage) => void) => Unsubscribe;
    decideApproval: (id: string, requestId: string, decision: ApprovalDecision) => Promise<boolean>;
    onApprovalRequest: (cb: (workspaceId: string, req: CommandApproval) => void) => Unsubscribe;
    decideSubagentApproval: (id: string, requestId: string, approved: boolean) => Promise<boolean>;
    onSubagentApprovalRequest: (cb: (workspaceId: string, req: SubagentCommandApproval) => void) => Unsubscribe;
  };
  diff: {
    decide: (
      id: string,
      diffId: string,
      hunkIndex: number | 'all',
      decision: 'accepted' | 'rejected'
    ) => Promise<PendingDiff | null>;
    onProposed: (cb: (workspaceId: string, diff: PendingDiff) => void) => Unsubscribe;
    onUpdated: (cb: (workspaceId: string, diff: PendingDiff) => void) => Unsubscribe;
  };
  roadmap: {
    decide: (id: string, itemId: string, decision: 'approve' | 'reject') => Promise<boolean>;
    edit: (id: string, itemId: string, patch: { title?: string; summary?: string; detail?: string }) => Promise<boolean>;
    pushBack: (id: string, itemId: string, newDetail: string) => Promise<boolean>;
    setStatus: (id: string, itemId: string, status: RoadmapItemStatus) => Promise<boolean>;
    onUpdated: (cb: (workspaceId: string, sessionId: string, items: RoadmapItem[]) => void) => Unsubscribe;
  };
  checkpoints: {
    list: (id: string) => Promise<Checkpoint[]>;
    undo: (id: string, filePath: string) => Promise<boolean>;
  };
  browser: {
    setBounds: (id: string, bounds: { x: number; y: number; width: number; height: number }) => Promise<boolean>;
    detach: () => Promise<boolean>;
    navigate: (id: string, url: string) => Promise<boolean>;
    back: (id: string) => Promise<boolean>;
    forward: (id: string) => Promise<boolean>;
    reload: (id: string) => Promise<boolean>;
    summarize: (id: string) => Promise<boolean>;
    saveClip: (id: string) => Promise<{ ok: true; path: string } | { ok: false; error: string }>;
    onNavState: (cb: (workspaceId: string, state: BrowserNavState) => void) => Unsubscribe;
  };
  voice: {
    transcribe: (buffer: ArrayBuffer, mimeType: string) => Promise<{ text: string; error?: string }>;
  };
  tts: {
    synthesize: (
      text: string,
      provider: TtsProvider,
      voice: string
    ) => Promise<{ audio: string | null; mimeType: string; error?: string }>;
    listVoices: (provider: TtsProvider) => Promise<TtsVoice[]>;
  };
  attachments: {
    save: (workspaceId: string, buffer: ArrayBuffer, mimeType: string) => Promise<ChatImage>;
  };
  image: {
    read: (workspaceId: string, filePath: string) => Promise<string | null>;
  };
  models: {
    list: (forceRefresh?: boolean) => Promise<{ ok: true; models: CatalogModel[] } | { ok: false; error: string }>;
    getCurrent: () => Promise<{ provider: ChatProvider; model: string }>;
    setCurrent: (modelId: string, provider: ChatProvider) => Promise<boolean>;
    setProvider: (provider: ChatProvider) => Promise<{ provider: ChatProvider; model: string }>;
    codexLoginStatus: () => Promise<{ ok: boolean; detail: string }>;
  };
  reasoning: {
    getCurrent: () => Promise<ReasoningLevel>;
    setCurrent: (level: ReasoningLevel) => Promise<ReasoningLevel>;
  };
  audit: {
    read: (workspaceId: string) => Promise<AuditReadResult>;
  };
  updates: {
    check: () => Promise<boolean>;
    download: () => Promise<boolean>;
    install: () => Promise<boolean>;
    onStatus: (cb: (status: UpdateStatus) => void) => Unsubscribe;
  };
  portal: {
    getStatus: () => Promise<PortalStatus>;
    enable: () => Promise<boolean>;
    disable: () => Promise<boolean>;
    onStatus: (cb: (status: PortalStatus) => void) => Unsubscribe;
  };
  settings: {
    get: () => Promise<ProviderSettings>;
    set: (values: Partial<ProviderSettings>) => Promise<boolean>;
  };
  perms: {
    get: () => Promise<PermissionOverrides>;
    set: (overrides: Partial<PermissionOverrides>) => Promise<boolean>;
    getAllowlist: () => Promise<string[]>;
    setAllowlist: (patterns: string[]) => Promise<boolean>;
  };
  scheduler: {
    list: (id: string) => Promise<ScheduledTask[]>;
    create: (id: string, label: string, prompt: string, schedule: ScheduleSpec) => Promise<ScheduledTask | null>;
    update: (
      id: string,
      taskId: string,
      patch: { label?: string; prompt?: string; schedule?: ScheduleSpec; enabled?: boolean }
    ) => Promise<boolean>;
    remove: (id: string, taskId: string) => Promise<boolean>;
    runNow: (id: string, taskId: string) => Promise<boolean>;
    onUpdated: (cb: (workspaceId: string, tasks: ScheduledTask[]) => void) => Unsubscribe;
  };
  focus: {
    list: (id: string) => Promise<FocusAgentSummary[]>;
    start: (id: string, task: string, label: string, budgetMinutes?: number) => Promise<FocusAgentSummary | null>;
    stop: (id: string, focusId: string) => Promise<boolean>;
    onUpdated: (cb: (workspaceId: string, agents: FocusAgentSummary[]) => void) => Unsubscribe;
    board: {
      list: (id: string) => Promise<FocusMessage[]>;
      answer: (id: string, requestId: string, answer: string) => Promise<boolean>;
      onUpdated: (cb: (workspaceId: string, messages: FocusMessage[]) => void) => Unsubscribe;
      onQuestion: (cb: (workspaceId: string, req: { requestId: string; from: string; question: string }) => void) => Unsubscribe;
    };
  };
}

declare global {
  interface Window {
    forge: ForgeApi;
  }
}

export const forge: ForgeApi = window.forge;
