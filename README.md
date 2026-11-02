# Nexo: MVP do "Discord 2.0"

Primeira versão do app: contas, servidores com convite, canais de texto e de voz, chat em tempo real e **transmissão de tela** no estilo "Go Live". O nome "Nexo" é provisório; troque em `web/src/api.ts` (`APP_NAME`) e em `web/index.html`.

## O que já funciona

- Cadastro e login (senha com bcrypt, sessão por JWT, limite de 10 tentativas por minuto)
- Criar servidor (já vem com `#geral` e o canal de voz `Geral`), convidar por link (`/convite/CODIGO`, válido por 7 dias) e entrar com convite
- Canais de texto e de voz (só o dono do servidor cria canais por enquanto)
- Chat em tempo real: enviar, editar, apagar, histórico com rolagem infinita, "fulano está digitando", markdown básico (`**negrito**`, `*itálico*`, `` `código` ``, `||spoiler||`, links)
- Reações nas mensagens (👍 ❤️ 😂 😮 😢 🔥 🎉 👀), com a lista de quem reagiu ao passar o mouse
- Sons: entrada e saída na call, mutar e desmutar, mensagem nova com a aba em segundo plano (o sino na barra do usuário desliga)
- Avisos na tela ("fulano entrou na call") e emojis que sobem flutuando na call para todo mundo
- Lista de membros online e offline
- Voz: entrar e sair, silenciar, ensurdecer, indicador de quem está falando, supressão de ruído e cancelamento de eco, lista de quem está em cada canal de voz na barra lateral
- Câmera
- **Conta e perfil** como no Discord: nome de exibição, usuário, senha, foto, banner, pronomes, "sobre mim" e status personalizado; cartão de perfil ao clicar em alguém
- **Status**: Disponível, Ausente (também sozinho depois de 10 minutos parado), Não perturbe (sem avisos nem sons) e Invisível
- **Configurações do servidor** (dono): nome e ícone, renomear/tópico/apagar canais, expulsar membros, convites com validade e limite de usos, apagar servidor; quem não é dono pode sair do servidor
- **Configurações do app**: aparência (tema escuro, meia-noite, claro ou do sistema; confortável ou compacto; fonte, espaçamento, zoom, 24 h), acessibilidade (saturação, reduzir movimento), chat (emoticons viram emoji, reações, links, spoilers), avisos na área de trabalho (todas, só menções ou nenhuma), lista de atalhos, modo streamer e opções do Windows no app (abrir com o computador, começar minimizado, fechar para a bandeja)
- **Configurações** de voz (engrenagem ao lado do seu nome ou na call): escolher microfone, saída de som e câmera; volume de entrada e de saída; teste de microfone com medidor e "ouvir minha voz"; detecção de voz com sensibilidade automática ou manual; aperte para falar com tecla e atraso ao soltar; supressão de ruído, cancelamento de eco e ganho automático; prévia da câmera. Ficam salvas no computador de cada um.
- Volume de cada pessoa na call (passe o mouse no quadrado dela)
- **Transmissão de tela**: escolha de tela, janela ou aba; qualidade 720p30, 1080p30, 1080p60 ou original 60 fps; "equilibrado" ou "movimento fluido (jogos)"; áudio da transmissão; botão de estatísticas (fps, resolução, perda e se o limite é a CPU ou a internet); quem está na sala vê "AO VIVO" e só recebe o vídeo depois de clicar em **Assistir transmissão**; ampliar e tela cheia

Testado ponta a ponta com dois navegadores: chat, voz e transmissão 1080p chegando no espectador.

## App para computador

O app (pasta `desktop/`, feito em Electron) abre o Nexo numa janela própria e adiciona:
- seletor de tela ou janela com miniaturas na hora de transmitir;
- áudio do computador na transmissão (Windows). No Windows 11 o som do próprio Nexo fica de fora (captura por processo, pacote `loopback-capture`), então quem assiste não ouve a própria voz de volta;
- links externos abrindo no navegador;
- atalhos globais de mutar e ensurdecer (funcionam com o jogo em foco);
- ícone na bandeja (perto do relógio) com mutar, ensurdecer e sair; abrir com o Windows e fechar para a bandeja;
- atualização automática (`electron-updater`): a partir da 0.1.3 o app baixa a versão nova sozinho da última release e pergunta se pode reiniciar.

**Para baixar:** https://github.com/LucasFort/Discord-2.0/releases/latest (Windows `.exe`, Linux `.AppImage`). Mande esse link para os amigos.

O instalador é gerado sozinho pelo GitHub Actions (`.github/workflows/desktop.yml`) sempre que algo em `desktop/` muda na `main`. Para lançar uma versão nova, aumente `version` em `desktop/package.json`. O app carrega o site do Render (`nexoUrl` no mesmo arquivo), então melhorias no site chegam no app sem precisar baixar de novo.

O Windows mostra "O Windows protegeu o computador" na primeira vez porque o app não tem assinatura digital (paga). Clique em **Mais informações > Executar assim mesmo**.

Rodar o app em desenvolvimento: `cd desktop && npm install && npm start` (use `NEXO_URL=http://localhost:5173 npm start` para apontar para o site local).

## Como rodar

Precisa de **Node.js 22.5 ou mais novo** (o banco usa o SQLite nativo do Node) e **Docker** (para o servidor de mídia).

```bash
npm run setup          # instala tudo
cp .env.example .env   # opcional; os padrões já funcionam em dev
npm run livekit        # sobe o servidor de mídia LiveKit no Docker
npm run dev            # sobe a API (porta 3001) e o site (porta 5173)
```

Abra http://localhost:5173, crie uma conta e um servidor. Para testar a transmissão sozinho, abra uma segunda janela anônima, crie outra conta e entre pelo link de convite.

Sem Docker: baixe o binário em https://github.com/livekit/livekit/releases e rode `livekit-server --dev`.

## Colocar online (Render + LiveKit Cloud, plano grátis)

Em produção a API também entrega o site, então é um único serviço (veja o `Dockerfile`). Voz e tela ficam no LiveKit Cloud.

1. **LiveKit Cloud:** crie uma conta em https://cloud.livekit.io e um projeto. Em *Settings > Keys* crie uma chave e anote três valores: a URL do projeto (começa com `wss://`), a API Key e o API Secret.
2. **Render:** crie uma conta em https://render.com entrando com o GitHub. Clique em **New > Blueprint**, escolha o repositório `Discord-2.0` e confirme. O Render lê o `render.yaml` e pede `LIVEKIT_URL`, `LIVEKIT_API_KEY` e `LIVEKIT_API_SECRET`: cole os valores do passo 1.
3. Espere o deploy terminar (alguns minutos) e abra o endereço `https://nexo-xxxx.onrender.com` que o Render mostrar. Já vem com HTTPS, que o navegador exige para microfone e tela.

O blueprint também cria um **Postgres grátis do Render** (`nexo-db`) e liga o app nele pela variável `DATABASE_URL`, então contas, servidores e mensagens sobrevivem a reinícios e deploys.

Limites do plano grátis do Render: o serviço dorme depois de 15 minutos sem uso (o primeiro acesso demora uns 50 segundos) e o Postgres grátis é apagado 30 dias depois de criado. Para guardar dados de verdade, suba o banco para um plano pago ou aponte `DATABASE_URL` para outro Postgres (Supabase, Neon etc.).

### Banco de dados

- Com `DATABASE_URL` definido, o app usa PostgreSQL.
- Sem `DATABASE_URL`, usa SQLite no arquivo `DB_PATH` (padrão `discord2.db`), ideal para desenvolvimento.

As tabelas são criadas sozinhas na primeira execução.

### Se a voz não funcionar online

Abra `https://SEU-APP.onrender.com/api/voice-config`. Precisa mostrar `"configured":true` e uma URL `wss://`. Erro "invalid token" quer dizer que a API Key e o API Secret não batem com o projeto da `LIVEKIT_URL`: gere uma chave nova no LiveKit e cole os 3 valores de novo em *nexo > Environment* no Render.

### Site também na Vercel (link oficial)

O site está publicado na Vercel (projeto `nexo`) e conversa com a API do Render acima.

1. Na Vercel, em *Settings > Environment Variables* do projeto, crie `VITE_API_URL` com o endereço do Render (ex.: `https://nexo-xxxx.onrender.com`, sem barra no final).
2. Refaça o deploy (*Deployments > Redeploy*). O valor entra no site na hora do build.

A Vercel não mantém WebSocket aberto, por isso a API e o tempo real continuam no Render. O `web/vercel.json` faz os links `/convite/CODIGO` abrirem o app.

## Estrutura

```
server/src/
  index.ts     servidor Fastify
  db.ts        tabelas SQLite e consultas
  auth.ts      login e JWT
  routes.ts    API REST e o token da sala de voz (LiveKit)
  gateway.ts   WebSocket de tempo real (mensagens, presença, digitando, quem está na voz)
web/src/
  App.tsx      telas: login, servidores, canais, chat, voz, transmissão
  store.ts     estado do app alimentado pelo WebSocket
  voice.ts     conexão de voz, câmera e transmissão de tela (livekit-client)
  styles.css   tema escuro
```

## Próximos passos (fase 2 do roadmap)

Cargos e permissões, amigos e DMs, respostas, anexos, notificações, aperte para falar, versão para Mac.
