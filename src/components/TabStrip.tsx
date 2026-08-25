import { useForge } from '../state/store';
import { IconPlus, IconX } from './icons';

export function TabStrip() {
  const order = useForge((s) => s.order);
  const workspaces = useForge((s) => s.workspaces);
  const activeId = useForge((s) => s.activeId);
  const selectWorkspace = useForge((s) => s.selectWorkspace);
  const closeWorkspace = useForge((s) => s.closeWorkspace);
  const newWorkspace = useForge((s) => s.newWorkspace);

  return (
    <div className="tabstrip">
      {order.map((id) => {
        const view = workspaces[id];
        if (!view) return null;
        const { summary } = view;
        const isActive = id === activeId;

        // A tab you're not looking at still reports what its agent is doing.
        const dot =
          summary.status === 'running'
            ? 'running'
            : summary.unseenCompletion
              ? 'done'
              : summary.status === 'review'
                ? 'review'
                : null;

        const title =
          summary.status === 'running'
            ? 'Agent is working in this workspace'
            : summary.unseenCompletion
              ? 'Finished while you were away'
              : summary.status === 'review'
                ? `${summary.pendingDiffCount} change${summary.pendingDiffCount === 1 ? '' : 's'} waiting for review`
                : summary.rootPath ?? summary.name;

        return (
          <div
            key={id}
            className={`wtab${isActive ? ' active' : ''}`}
            onClick={() => selectWorkspace(id)}
            title={title}
          >
            {dot && <div className={`wdot ${dot}`} />}
            <span className="wname">{summary.name}</span>
            <button
              className="wclose"
              onClick={(e) => {
                e.stopPropagation();
                closeWorkspace(id);
              }}
              aria-label="Close workspace"
            >
              <IconX className="icon-xs" />
            </button>
          </div>
        );
      })}
      <button className="wnew" onClick={newWorkspace} title="New workspace" aria-label="New workspace">
        <IconPlus className="icon-sm" />
      </button>
    </div>
  );
}
