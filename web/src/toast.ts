import { useEffect, useState } from 'react';

/** Avisos rápidos no canto da tela ("Fulano entrou na call"). */
export type Toast = { id: number; text: string; kind?: 'join' | 'leave' | 'info' | 'error' };

let next = 1;
let toasts: Toast[] = [];
const listeners = new Set<(t: Toast[]) => void>();
const emit = () => listeners.forEach((l) => l(toasts));

export function toast(text: string, kind: Toast['kind'] = 'info') {
  const t = { id: next++, text, kind };
  toasts = [...toasts.slice(-3), t];
  emit();
  setTimeout(() => {
    toasts = toasts.filter((x) => x.id !== t.id);
    emit();
  }, 3500);
}

export function useToasts() {
  const [list, setList] = useState(toasts);
  useEffect(() => {
    listeners.add(setList);
    return () => void listeners.delete(setList);
  }, []);
  return list;
}
