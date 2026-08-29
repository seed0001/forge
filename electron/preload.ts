import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from './ipc-channels';
import type {
  ProviderSettings,
  ChatProvider,
  WorkspaceKind,
  WorkspaceType,
  PermissionOverrides,
  ApprovalDecision,
  ScheduleSpec,
  TtsProvider,
  ReasoningLevel,
} from './ipc-channels';

/** Subscribe helper: events are broadcast for every workspace, tagged with its id. */
function on<T extends unknown[]>(channel: string, cb: (...args: T) => void) {
  const listener = (_e: unknown, ...args: unknown[]) => cb(...(args as T));
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('forge', {
  workspaces: {
    list: () => ipcRenderer.invoke(IPC.wsList),
    create: (type?: WorkspaceType) => ipcRenderer.invoke(IPC.wsCreate, type),
    close: (id: string) => ipcRenderer.invoke(IPC.wsClose, id),
    setRoot: (id: string) => ipcRenderer.invoke(IPC.wsSetRoot, id),
    hydrate: (id: string) => ipcRenderer.invoke(IPC.wsHydrate, id),
    markSeen: (id: string) => ipcRenderer.invoke(IPC.wsMarkSeen, id),
    setAutonomy: (id: string, level: 'manual' | 'balanced' | 'auto') =>
      ipcRenderer.invoke(IPC.wsSetAutonomy, id, level),
    setKind: (id: string, kind: WorkspaceKind) => ipcRenderer.invoke(IPC.wsSetKind, id, kind),
    setClipsFolder: (id: string) => ipcRenderer.invoke(IPC.wsSetClipsFolder, id),
    setActive: (id: string) => ipcRenderer.invoke(IPC.wsSetActive, id),
    getInitialActive: () => ipcRenderer.invoke(IPC.wsGetInitialActive),
    onUpdated: (cb: (summary: unknown) => void) => on(IPC.wsUpdated, cb),
  },
  workspaceTree: {
    list: () => ipcRenderer.invoke(IPC.wsTreeList),
    rename: (workspaceId: string, label: string) => ipcRenderer.invoke(IPC.wsRename, workspaceId, label),
    setMeta: (workspaceId: string, text: string) => ipcRenderer.invoke(IPC.wsSetMeta, workspaceId, text),
    addProject: (workspaceId: string) => ipcRenderer.invoke(IPC.projectAdd, workspaceId),
    listProjects: (workspaceId: string) => ipcRenderer.invoke(IPC.projectList, workspaceId),
    removeProject: (workspaceId: string, projectId: string) => ipcRenderer.invoke(IPC.projectRemove, workspaceId, projectId),
    setActiveProject: (workspaceId: string, projectId: string) =>
      ipcRenderer.invoke(IPC.projectSetActive, workspaceId, projectId),
  },
  sessions: {
    list: (id: string) => ipcRenderer.invoke(IPC.sessList, id),
    create: (id: string) => ipcRenderer.invoke(IPC.sessNew, id),
    select: (id: string, sessionId: string) => ipcRenderer.invoke(IPC.sessSelect, id, sessionId),
    remove: (id: string, sessionId: string) => ipcRenderer.invoke(IPC.sessDelete, id, sessionId),
    onUpdated: (cb: (workspaceId: string, sessions: unknown) => void) => on(IPC.sessUpdated, cb),
  },
  fs: {
    listDir: (workspaceId: string, dirPath: string) => ipcRenderer.invoke(IPC.fsListDir, workspaceId, dirPath),
    listTree: (id: string) => ipcRenderer.invoke(IPC.fsListTree, id),
    readFile: (workspaceId: string, filePath: string) => ipcRenderer.invoke(IPC.fsReadFile, workspaceId, filePath),
    writeFile: (id: string, filePath: string, content: string) =>
      ipcRenderer.invoke(IPC.fsWriteFile, id, filePath, content),
    openInBrowser: (filePath: string) => ipcRenderer.invoke(IPC.fsOpenInBrowser, filePath),
  },
  terminal: {
    run: (id: string, command: string) => ipcRenderer.invoke(IPC.termRun, id, command),
    kill: (id: string) => ipcRenderer.invoke(IPC.termKill, id),
    onData: (cb: (workspaceId: string, evt: unknown) => void) => on(IPC.termData, cb),
  },
  agent: {
    send: (id: string, text: string, images?: unknown[]) => ipcRenderer.invoke(IPC.agentSend, id, text, images),
    stop: (id: string) => ipcRenderer.invoke(IPC.agentStop, id),
    onActivity: (cb: (workspaceId: string, sessionId: string, evt: unknown) => void) => on(IPC.agentActivity, cb),
    onMessage: (cb: (workspaceId: string, sessionId: string, msg: unknown) => void) => on(IPC.agentMessage, cb),
    decideApproval: (id: string, requestId: string, decision: ApprovalDecision) =>
      ipcRenderer.invoke(IPC.cmdApprovalDecide, id, requestId, decision),
    onApprovalRequest: (cb: (workspaceId: string, req: unknown) => void) => on(IPC.cmdApprovalRequest, cb),
    decideSubagentApproval: (id: string, requestId: string, approved: boolean) =>
      ipcRenderer.invoke(IPC.subagentCmdApprovalDecide, id, requestId, approved),
    onSubagentApprovalRequest: (cb: (workspaceId: string, req: unknown) => void) =>
      on(IPC.subagentCmdApprovalRequest, cb),
  },
  diff: {
    decide: (id: string, diffId: string, hunkIndex: number | 'all', decision: 'accepted' | 'rejected') =>
      ipcRenderer.invoke(IPC.diffDecide, id, diffId, hunkIndex, decision),
    onProposed: (cb: (workspaceId: string, diff: unknown) => void) => on(IPC.diffProposed, cb),
    onUpdated: (cb: (workspaceId: string, diff: unknown) => void) => on(IPC.diffUpdated, cb),
  },
  roadmap: {
    decide: (id: string, itemId: string, decision: 'approve' | 'reject') =>
      ipcRenderer.invoke(IPC.roadmapDecide, id, itemId, decision),
    edit: (id: string, itemId: string, patch: { title?: string; summary?: string; detail?: string }) =>
      ipcRenderer.invoke(IPC.roadmapEdit, id, itemId, patch),
    pushBack: (id: string, itemId: string, newDetail: string) =>
      ipcRenderer.invoke(IPC.roadmapPushBack, id, itemId, newDetail),
    setStatus: (id: string, itemId: string, status: string) =>
      ipcRenderer.invoke(IPC.roadmapSetStatus, id, itemId, status),
    onUpdated: (cb: (workspaceId: string, sessionId: string, items: unknown) => void) =>
      on(IPC.roadmapUpdated, cb),
  },
  checkpoints: {
    list: (id: string) => ipcRenderer.invoke(IPC.checkpointList, id),
    undo: (id: string, filePath: string) => ipcRenderer.invoke(IPC.checkpointUndo, id, filePath),
  },
  browser: {
    setBounds: (id: string, bounds: { x: number; y: number; width: number; height: number }) =>
      ipcRenderer.invoke(IPC.browserSetBounds, id, bounds),
    detach: () => ipcRenderer.invoke(IPC.browserDetach),
    navigate: (id: string, url: string) => ipcRenderer.invoke(IPC.browserNavigate, id, url),
    back: (id: string) => ipcRenderer.invoke(IPC.browserBack, id),
    forward: (id: string) => ipcRenderer.invoke(IPC.browserForward, id),
    reload: (id: string) => ipcRenderer.invoke(IPC.browserReload, id),
    summarize: (id: string) => ipcRenderer.invoke(IPC.browserSummarize, id),
    saveClip: (id: string) => ipcRenderer.invoke(IPC.browserSaveClip, id),
    onNavState: (cb: (workspaceId: string, state: unknown) => void) => on(IPC.browserNavState, cb),
  },
  voice: {
    transcribe: (buffer: ArrayBuffer, mimeType: string) =>
      ipcRenderer.invoke(IPC.voiceTranscribe, buffer, mimeType),
  },
  tts: {
    synthesize: (text: string, provider: TtsProvider, voice: string) =>
      ipcRenderer.invoke(IPC.ttsSynthesize, text, provider, voice),
    listVoices: (provider: TtsProvider) => ipcRenderer.invoke(IPC.ttsListVoices, provider),
  },
  attachments: {
    save: (workspaceId: string, buffer: ArrayBuffer, mimeType: string) =>
      ipcRenderer.invoke(IPC.attachmentSave, workspaceId, buffer, mimeType),
  },
  image: {
    read: (workspaceId: string, filePath: string) => ipcRenderer.invoke(IPC.imageRead, workspaceId, filePath),
  },
  models: {
    list: (forceRefresh?: boolean) => ipcRenderer.invoke(IPC.modelsList, forceRefresh),
    getCurrent: () => ipcRenderer.invoke(IPC.modelsGetCurrent),
    setCurrent: (modelId: string, provider: ChatProvider) => ipcRenderer.invoke(IPC.modelsSetCurrent, modelId, provider),
    setProvider: (provider: ChatProvider) => ipcRenderer.invoke(IPC.providerSet, provider),
    codexLoginStatus: (): Promise<{ ok: boolean; detail: string }> => ipcRenderer.invoke(IPC.codexLoginStatus),
  },
  reasoning: {
    getCurrent: (): Promise<ReasoningLevel> => ipcRenderer.invoke(IPC.reasoningGetCurrent),
    setCurrent: (level: ReasoningLevel): Promise<ReasoningLevel> => ipcRenderer.invoke(IPC.reasoningSetCurrent, level),
  },
  audit: {
    read: (workspaceId: string) => ipcRenderer.invoke(IPC.auditRead, workspaceId),
  },
  updates: {
    check: () => ipcRenderer.invoke(IPC.updateCheck),
    download: () => ipcRenderer.invoke(IPC.updateDownload),
    install: () => ipcRenderer.invoke(IPC.updateInstall),
    onStatus: (cb: (status: unknown) => void) => on(IPC.updateStatus, cb),
  },
  portal: {
    getStatus: () => ipcRenderer.invoke(IPC.portalGetStatus),
    enable: () => ipcRenderer.invoke(IPC.portalEnable),
    disable: () => ipcRenderer.invoke(IPC.portalDisable),
    onStatus: (cb: (status: unknown) => void) => on(IPC.portalStatus, cb),
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    set: (values: Partial<ProviderSettings>) => ipcRenderer.invoke(IPC.settingsSet, values),
  },
  perms: {
    get: () => ipcRenderer.invoke(IPC.permsGet),
    set: (overrides: Partial<PermissionOverrides>) => ipcRenderer.invoke(IPC.permsSet, overrides),
    getAllowlist: () => ipcRenderer.invoke(IPC.permsGetAllowlist),
    setAllowlist: (patterns: string[]) => ipcRenderer.invoke(IPC.permsSetAllowlist, patterns),
  },
  scheduler: {
    list: (id: string) => ipcRenderer.invoke(IPC.schedList, id),
    create: (id: string, label: string, prompt: string, schedule: ScheduleSpec) =>
      ipcRenderer.invoke(IPC.schedCreate, id, label, prompt, schedule),
    update: (
      id: string,
      taskId: string,
      patch: { label?: string; prompt?: string; schedule?: ScheduleSpec; enabled?: boolean }
    ) => ipcRenderer.invoke(IPC.schedUpdate, id, taskId, patch),
    remove: (id: string, taskId: string) => ipcRenderer.invoke(IPC.schedDelete, id, taskId),
    runNow: (id: string, taskId: string) => ipcRenderer.invoke(IPC.schedRunNow, id, taskId),
    onUpdated: (cb: (workspaceId: string, tasks: unknown) => void) => on(IPC.schedUpdated, cb),
  },
  focus: {
    list: (id: string) => ipcRenderer.invoke(IPC.focusList, id),
    start: (id: string, task: string, label: string, budgetMinutes?: number) =>
      ipcRenderer.invoke(IPC.focusStart, id, task, label, budgetMinutes),
    stop: (id: string, focusId: string) => ipcRenderer.invoke(IPC.focusStop, id, focusId),
    onUpdated: (cb: (workspaceId: string, agents: unknown) => void) => on(IPC.focusUpdated, cb),
    board: {
      list: (id: string) => ipcRenderer.invoke(IPC.focusBoardList, id),
      answer: (id: string, requestId: string, answer: string) =>
        ipcRenderer.invoke(IPC.focusQuestionAnswer, id, requestId, answer),
      onUpdated: (cb: (workspaceId: string, messages: unknown) => void) => on(IPC.focusBoardUpdated, cb),
      onQuestion: (cb: (workspaceId: string, req: unknown) => void) => on(IPC.focusQuestionRequest, cb),
    },
  },
});
