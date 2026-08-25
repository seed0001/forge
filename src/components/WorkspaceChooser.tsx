import { useForge } from '../state/store';
import { IconCode, IconGlobe } from './icons';

export function WorkspaceChooser() {
  const setWorkspaceKind = useForge((s) => s.setWorkspaceKind);

  return (
    <div className="chooser">
      <div className="chooser-inner">
        <h1>What kind of workspace?</h1>
        <p>You can always open another one from the tab bar — this only decides what this one does.</p>

        <div className="chooser-cards">
          <button className="card chooser-card" onClick={() => setWorkspaceKind('coding')}>
            <IconCode className="icon" />
            <div className="card-title">Coding</div>
            <div className="chooser-card-blurb">
              Open a project folder — the agent reads files, runs commands, and proposes edits you review.
            </div>
          </button>

          <button className="card chooser-card" onClick={() => setWorkspaceKind('browsing')}>
            <IconGlobe className="icon" />
            <div className="card-title">Browsing</div>
            <div className="chooser-card-blurb">
              A real embedded browser — navigate the web, then index, summarize, or save any page as a
              markdown clip you can discuss with the agent.
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}
