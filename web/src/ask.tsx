import { useEffect, useRef, useState } from 'react';

/**
 * Caixa de texto dentro do próprio site no lugar do prompt() do navegador
 * (o app de computador, feito em Electron, não suporta prompt()).
 */
type Request = { title: string; value?: string; readOnly?: boolean; okText?: string; resolve: (v: string | null) => void };

let show: ((r: Request) => void) | null = null;

export function ask(title: string, opts: { value?: string; readOnly?: boolean; okText?: string } = {}): Promise<string | null> {
  return new Promise((resolve) => {
    if (!show) return resolve(window.prompt(title, opts.value ?? ''));
    show({ title, ...opts, resolve });
  });
}

export function AskHost() {
  const [req, setReq] = useState<Request | null>(null);
  const [value, setValue] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    show = (r) => {
      setValue(r.value ?? '');
      setReq(r);
    };
    return () => void (show = null);
  }, []);
  useEffect(() => {
    if (req) setTimeout(() => input.current?.select(), 0);
  }, [req]);
  if (!req) return null;
  const close = (v: string | null) => {
    req.resolve(v);
    setReq(null);
  };
  return (
    <div className="modal-backdrop" onClick={() => close(null)}>
      <form
        className="modal ask"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          close(req.readOnly ? null : value);
        }}
      >
        <h2>{req.title}</h2>
        <input
          ref={input}
          value={value}
          readOnly={req.readOnly}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && close(null)}
          autoFocus
        />
        <div className="modal-actions">
          {!req.readOnly && <button type="button" className="link" onClick={() => close(null)}>Cancelar</button>}
          <button className="primary">{req.okText ?? (req.readOnly ? 'Fechar' : 'Confirmar')}</button>
        </div>
      </form>
    </div>
  );
}
