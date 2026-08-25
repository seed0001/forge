import { useState, memo, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { IconCheck, IconCopy } from './icons';

function textOf(node: ReactNode): string {
  if (node == null || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'object' && 'props' in (node as never)) {
    return textOf((node as { props: { children?: ReactNode } }).props.children);
  }
  return '';
}

type CopyStatus = 'idle' | 'copied' | 'failed';

function CodeBlock({ children, language }: { children: ReactNode; language: string | null }) {
  const [status, setStatus] = useState<CopyStatus>('idle');

  async function copy() {
    const text = textOf(children);
    try {
      await navigator.clipboard.writeText(text);
      setStatus('copied');
    } catch {
      // Fallback for a context where the async Clipboard API is unavailable —
      // a hidden textarea + the legacy copy command still works everywhere.
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        setStatus('copied');
      } catch {
        setStatus('failed');
      }
    }
    setTimeout(() => setStatus('idle'), 1400);
  }

  return (
    <div className="md-code">
      <div className="md-code-bar">
        <span className="md-code-lang">{language ?? 'text'}</span>
        <button className={`md-copy${status === 'failed' ? ' failed' : ''}`} onClick={copy} title="Copy">
          {status === 'copied' ? <IconCheck className="icon-xs" /> : <IconCopy className="icon-xs" />}
          {status === 'copied' ? 'Copied' : status === 'failed' ? 'Could not copy' : 'Copy'}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

/**
 * Agent replies are markdown. Raw HTML is deliberately NOT enabled — model
 * output is untrusted, and react-markdown escapes it by default.
 */
export const Markdown = memo(function Markdown({ children }: { children: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{
          pre: ({ children }) => {
            // The <code> child carries the hljs language class.
            const child = children as { props?: { className?: string } } | undefined;
            const match = /language-(\w+)/.exec(child?.props?.className ?? '');
            return <CodeBlock language={match?.[1] ?? null}>{children}</CodeBlock>;
          },
          table: ({ children }) => (
            <div className="md-table-wrap">
              <table>{children}</table>
            </div>
          ),
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
          input: ({ checked, type }) =>
            type === 'checkbox' ? (
              <input type="checkbox" checked={!!checked} readOnly className="md-check" />
            ) : null,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});
