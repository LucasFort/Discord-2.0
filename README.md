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

## Colocar online (Render + LiveKit Cloud, plano grátis)

Em produção a API também entrega o site, então é um único serviço (veja o `Dockerfile`). Voz e tela ficam no LiveKit Cloud.

1. **LiveKit Cloud:** crie uma conta em https://cloud.livekit.io e um projeto. Em *Settings > Keys* crie uma chave e anote três valores: a URL do projeto (começa com `wss://`), a API Key e o API Secret.
2. **Render:** crie uma conta em https://render.com entrando com o GitHub. Clique em **New > Blueprint**, escolha o repositório `Discord-2.0` e confirme. O Render lê o `render.yaml` e pede `LIVEKIT_URL`, `LIVEKIT_API_KEY` e `LIVEKIT_API_SECRET`: cole os valores do passo 1.
3. Espere o deploy terminar (alguns minutos) e abra o endereço `https://nexo-xxxx.onrender.com` que o Render mostrar. Já vem com HTTPS, que o navegador exige para microfone e tela.

Limites do plano grátis do Render: o serviço dorme depois de 15 minutos sem uso (o primeiro acesso demora uns 50 segundos) e o banco SQLite é apagado a cada deploy ou reinício. Serve para testar; para guardar dados de verdade, use um disco pago no Render ou troque para PostgreSQL.

## Publicar (link oficial)

São três partes, cada uma num lugar:

| Parte | Onde | Como |
|---|---|---|
| Site (`web/`) | **Vercel** | Projeto com *Root Directory* `web`. Variável `VITE_API_URL` = endereço público da API (ex.: `https://nexo-api.onrender.com`). Refaça o deploy depois de mudar a variável. |
| API (`server/`) | **Render** (ou Railway) | A Vercel não mantém WebSocket aberto, então a API fica fora dela. No Render: *New > Blueprint* com este repositório (usa o `render.yaml`). |
| Voz e tela | **LiveKit Cloud** | Crie um projeto em cloud.livekit.io e copie `LIVEKIT_URL` (`wss://...`), `LIVEKIT_API_KEY` e `LIVEKIT_API_SECRET` para as variáveis da API. |

No plano grátis do Render o banco SQLite fica em disco temporário: contas e mensagens somem quando o serviço reinicia. Para guardar de vez, use um disco persistente (plano pago do Render ou volume no Railway) apontando `DB_PATH` para ele, ou troque para PostgreSQL.

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
