# Nexo: MVP do "Discord 2.0"

Primeira versão do app: contas, servidores com convite, canais de texto e de voz, chat em tempo real e **transmissão de tela** no estilo "Go Live". O nome "Nexo" é provisório; troque em `web/src/api.ts` (`APP_NAME`) e em `web/index.html`.

## O que já funciona

- Cadastro e login (senha com bcrypt e sessão por JWT)
- Criar servidor (já vem com `#geral` e o canal de voz `Geral`), convidar por link (`/convite/CODIGO`, válido por 7 dias) e entrar com convite
- Canais de texto e de voz (só o dono do servidor cria canais por enquanto)
- Chat em tempo real: enviar, editar, apagar, histórico com rolagem infinita, "fulano está digitando", markdown básico (`**negrito**`, `*itálico*`, `` `código` ``, `||spoiler||`, links)
- Lista de membros online e offline
- Voz: entrar e sair, silenciar, ensurdecer, indicador de quem está falando, supressão de ruído e cancelamento de eco, lista de quem está em cada canal de voz na barra lateral
- Câmera
- **Transmissão de tela**: escolha de tela, janela ou aba; qualidade 720p30, 1080p30, 1080p60 ou original 60 fps; "texto nítido" ou "movimento fluido"; áudio da transmissão; quem está na sala vê "AO VIVO" e só recebe o vídeo depois de clicar em **Assistir transmissão**; ampliar e tela cheia

Testado ponta a ponta com dois navegadores: chat, voz e transmissão 1080p chegando no espectador.

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

### Testar com amigos em outra rede

Em dev tudo roda em `localhost`. Para outras pessoas entrarem você precisa publicar a API, o site e o LiveKit com HTTPS (o navegador só libera microfone e tela em HTTPS). O caminho mais curto é usar o **LiveKit Cloud** (tem plano gratuito): crie um projeto e coloque `LIVEKIT_URL`, `LIVEKIT_API_KEY` e `LIVEKIT_API_SECRET` no `.env`.

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

Cargos e permissões, amigos e DMs, reações e respostas, anexos, notificações, aperte para falar, app desktop em Electron (seletor de janela próprio e áudio do sistema), troca do SQLite por PostgreSQL.
