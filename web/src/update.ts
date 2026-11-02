import { useEffect, useState } from 'react';

/**
 * Atualização automática: cada build tem um id (version.json). O app aberto confere de tempos em
 * tempos, ao voltar para a janela e quando a conexão com o servidor volta (o servidor reinicia em
 * todo deploy). Se o id mudou, saiu versão nova.
 */
let available = false;
const listeners = new Set<(v: boolean) => void>();
let checking = false;

export async function checkForUpdate() {
  if (!import.meta.env.PROD || available || checking) return;
  checking = true;
  try {
    const r = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) return;
    const { id } = (await r.json()) as { id?: string };
    if (id && id !== __BUILD_ID__) {
      available = true;
      listeners.forEach((l) => l(true));
    }
  } catch {
    /* sem internet ou servidor reiniciando: tenta de novo depois */
  } finally {
    checking = false;
  }
}

if (typeof window !== 'undefined' && import.meta.env.PROD) {
  setInterval(checkForUpdate, 60_000);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && checkForUpdate());
  window.addEventListener('online', () => checkForUpdate());
  window.addEventListener('focus', () => checkForUpdate());
}

export function useUpdateAvailable() {
  const [v, setV] = useState(available);
  useEffect(() => {
    listeners.add(setV);
    return () => void listeners.delete(setV);
  }, []);
  return v;
}
