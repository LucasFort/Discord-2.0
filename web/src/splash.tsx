import { useState } from 'react';

/** Dicas da tela de carregamento (como o "Você sabia?" do Discord), uma aleatória por vez. */
export const TIPS = [
  'Aperte ↑ na caixa de mensagem para editar a última mensagem que você mandou.',
  'Arraste um arquivo para o chat (ou cole com Ctrl+V) para mandar na hora.',
  'Shift+Enter pula uma linha sem enviar a mensagem.',
  'Clique com o botão direito em alguém na call para mudar o volume só dessa pessoa.',
  'Escreva @todos para avisar todo mundo do servidor.',
  'Passe o mouse numa mensagem e clique no alfinete para fixar no canal.',
  'Em Configurações > Voz, "Ouvir minha voz" mostra como os outros te escutam.',
  'Com fone de ouvido seus amigos não ouvem a própria voz de volta.',
  'O modo streamer esconde convites e nomes de usuário enquanto você transmite.',
  'Clique na sua foto lá embaixo para mudar o status para Não perturbe.',
  'Use ||spoiler|| para esconder um texto até alguém clicar.',
  'A busca no topo do chat procura mensagens no servidor inteiro.',
];
export const randomTip = () => TIPS[Math.floor(Math.random() * TIPS.length)];

/** Logo do Nexo com as ondas acendendo em sequência (o "carregando"). */
export function SplashLogo({ size = 96 }: { size?: number }) {
  return (
    <svg className="splash-logo" width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">
      <rect x="4" y="4" width="92" height="92" rx="24" fill="url(#nexo-g)" />
      <defs>
        <linearGradient id="nexo-g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#8b5cff" />
          <stop offset="1" stopColor="#5b3fe0" />
        </linearGradient>
      </defs>
      <circle className="splash-dot" cx="50" cy="50" r="7" fill="#fff" />
      <g fill="none" stroke="#fff" strokeWidth="6" strokeLinecap="round">
        <path className="splash-wave w1" d="M38 38 a17 17 0 0 0 0 24 M62 38 a17 17 0 0 1 0 24" />
        <path className="splash-wave w2" d="M29 29 a30 30 0 0 0 0 42 M71 29 a30 30 0 0 1 0 42" />
      </g>
    </svg>
  );
}

/** Tela de carregamento do Nexo: logo animado, uma dica e o que está acontecendo agora. */
export function Splash({ status, children }: { status: string; children?: React.ReactNode }) {
  const [tip] = useState(randomTip);
  return (
    <div className="splash">
      <SplashLogo />
      <div className="splash-tip">
        <strong>VOCÊ SABIA?</strong>
        <p>{tip}</p>
      </div>
      <small className="splash-status">{status}</small>
      {children}
    </div>
  );
}
