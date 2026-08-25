import { useEffect, useRef, useState } from 'react';
import { useForge, useActiveWorkspace } from '../state/store';
import { stripAnsi } from '../lib/ansi';
import { IconTerminal } from './icons';

export function TerminalPanel() {
  const view = useActiveWorkspace();
  const runCommand = useForge((s) => s.runCommand);
  const [input, setInput] = useState('');
  const bodyRef = useRef<HTMLDivElement>(null);

  const lines = view?.terminalLines ?? [];

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [lines.length]);

  function submit() {
    const cmd = input.trim();
    if (!cmd) return;
    setInput('');
    runCommand(cmd);
  }

  return (
    <div className="terminal">
      <div className="term-head">
        <IconTerminal className="icon-xs" />
        Terminal
      </div>

      <div className="term-body" ref={bodyRef}>
        {lines.length === 0 && (
          <div className="term-line">
            <div className="term-gutter" />
            <div className="term-text dim">Run a command, or let the agent run one — each is labelled.</div>
          </div>
        )}
        {lines.map((line) => (
          <div className="term-line" key={line.id}>
            <div className="term-gutter">
              {line.kind === 'cmd' && (
                <span className={`term-tag ${line.source}`}>{line.source === 'agent' ? 'AGENT' : 'YOU'}</span>
              )}
            </div>
            {line.kind === 'cmd' && <div className="term-text cmd">$ {line.text}</div>}
            {line.kind === 'exit' && <div className="term-text dim">exit {line.text}</div>}
            {line.kind === 'info' && <div className="term-text dim">{line.text}</div>}
            {(line.kind === 'stdout' || line.kind === 'stderr') && (
              <div className={`term-text${line.kind === 'stderr' ? ' err' : ''}`}>{stripAnsi(line.text)}</div>
            )}
          </div>
        ))}
      </div>

      <div className="term-input">
        <span className="term-caret">$</span>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="Run a command"
          spellCheck={false}
        />
      </div>
    </div>
  );
}
