import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Rendered instead of the crashed subtree. A function gets the error and a reset callback. */
  fallback?: ReactNode | ((error: Error, reset: () => void) => ReactNode);
  /** Optional label for the console message, so it's clear which boundary caught it. */
  label?: string;
}

interface State {
  error: Error | null;
}

/**
 * A render crash anywhere below this boundary is caught here instead of
 * unmounting the whole React tree (the white-screen failure). The default
 * fallback is a small, self-contained panel with a "try again" that clears the
 * error state and re-renders the children.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[ErrorBoundary${this.props.label ? `: ${this.props.label}` : ''}]`, error, info.componentStack);
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const { fallback } = this.props;
    if (typeof fallback === 'function') return fallback(error, this.reset);
    if (fallback !== undefined) return fallback;

    return (
      <div className="error-boundary" role="alert">
        <p className="error-boundary-title">Something in this view crashed.</p>
        <p className="error-boundary-detail">{error.message || String(error)}</p>
        <button className="error-boundary-retry" onClick={this.reset}>
          Try again
        </button>
      </div>
    );
  }
}
