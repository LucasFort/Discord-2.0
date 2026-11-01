import { Component, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

/** Se alguma parte da tela quebrar, mostra o erro e um botão de recarregar em vez de uma página cinza vazia. */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error('Nexo quebrou:', error);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="loading">
        <div className="crash">
          <h2>Algo deu errado nesta tela</h2>
          <p className="muted">Recarregar resolve. Se acontecer de novo, mande um print desta mensagem.</p>
          <pre>{String(this.state.error?.message ?? this.state.error)}</pre>
          <button className="primary" onClick={() => location.reload()}>Recarregar</button>
        </div>
      </div>
    );
  }
}

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
