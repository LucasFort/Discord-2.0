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

/** Ícone do Nexo (o N com a órbita) balançando de leve enquanto carrega. */
export function SplashLogo({ size = 96 }: { size?: number }) {
  return <img className="splash-logo" src="/icon-192.png" width={size} height={size} alt="" />;
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
