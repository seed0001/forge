import type {
  FileNode,
  ActivityEvent,
  TermDataEvent,
  PendingDiff,
  Checkpoint,
  ChatMessage,
  ChatImage,
  WorkspaceSummary,
  WorkspaceHydration,
  SessionSummary,
  Autonomy,
  CommandApproval,
  OpenRouterModel,
  UpdateStatus,
} from '../../electron/ipc-channels';

type Unsubscribe = () => void;

export interface ForgeApi {
  workspaces: {
    list: () => Promise<WorkspaceSummary[]>;
    create: () => Promise<WorkspaceSummary>;
    close: (id: string) => Promise<WorkspaceSummary[]>;
    setRoot: (id: string) => Promise<WorkspaceSummary | null>;
    hydrate: (id: string) => Promise<WorkspaceHydration | null>;
    markSeen: (id: string) => Promise<WorkspaceSummary | null>;
    setAutonomy: (id: string, level: Autonomy) => Promise<WorkspaceSummary | null>;
    onUpdated: (cb: (summary: WorkspaceSummary) => void) => Unsubscribe;
  };
  sessions: {
    list: (id: string) => Promise<SessionSummary[]>;
    create: (id: string) => Promise<SessionSummary | null>;
    select: (
      id: string,
      sessionId: string
    ) => Promise<{ chat: ChatMessage[]; activity: ActivityEvent[]; summary: WorkspaceSummary } | null>;
    remove: (id: string, sessionId: string) => Promise<SessionSummary[]>;
    onUpdated: (cb: (workspaceId: string, sessions: SessionSummary[]) => void) => Unsubscribe;
  };
  fs: {
    listDir: (dirPath: string) => Promise<FileNode[]>;
    listTree: (id: string) => Promise<FileNode[]>;
    readFile: (filePath: string) => Promise<string>;
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
    onActivity: (cb: (workspaceId: string, evt: ActivityEvent) => void) => Unsubscribe;
    onMessage: (cb: (workspaceId: string, msg: ChatMessage) => void) => Unsubscribe;
    decideApproval: (id: string, requestId: string, approved: boolean) => Promise<boolean>;
    onApprovalRequest: (cb: (workspaceId: string, req: CommandApproval) => void) => Unsubscribe;
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
  checkpoints: {
    list: (id: string) => Promise<Checkpoint[]>;
    undo: (id: string, filePath: string) => Promise<boolean>;
  };
  voice: {
    transcribe: (buffer: ArrayBuffer, mimeType: string) => Promise<{ text: string; error?: string }>;
  };
  attachments: {
    save: (workspaceId: string, buffer: ArrayBuffer, mimeType: string) => Promise<ChatImage>;
  };
  image: {
    read: (workspaceId: string, filePath: string) => Promise<string | null>;
  };
  models: {
    list: (forceRefresh?: boolean) => Promise<{ ok: true; models: OpenRouterModel[] } | { ok: false; error: string }>;
    getCurrent: () => Promise<string>;
    setCurrent: (modelId: string) => Promise<boolean>;
  };
  updates: {
    check: () => Promise<boolean>;
    download: () => Promise<boolean>;
    install: () => Promise<boolean>;
    onStatus: (cb: (status: UpdateStatus) => void) => Unsubscribe;
  };
}

declare global {
  interface Window {
    forge: ForgeApi;
  }
}

export const forge: ForgeApi = window.forge;
