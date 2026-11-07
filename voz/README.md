# Servidor de voz próprio e grátis (Oracle Cloud)

Voz, câmera e transmissão de tela passam por um servidor LiveKit. O plano grátis do LiveKit Cloud
acaba rápido com transmissão de tela, então aqui o LiveKit roda numa VM **Always Free da Oracle
Cloud**, que não cobra nada e dá **10 TB de saída por mês** (sobra muito para um grupo de amigos).

Leva uns 30 minutos. Você vai precisar de: uma conta Google ou GitHub (para o DuckDNS) e um cartão
(a Oracle só usa para confirmar a conta; a VM grátis não gera cobrança).

## 1. Um endereço grátis (DuckDNS)

1. Entre em https://www.duckdns.org com Google ou GitHub.
2. Em *sub domain* digite um nome (ex.: `nexo-voz-lucas`) e clique em **add domain**.
   Seu endereço vai ser `nexo-voz-lucas.duckdns.org`. Deixe a aba aberta: o IP vem no passo 3.

## 2. A VM grátis na Oracle Cloud

1. Crie a conta em https://signup.cloud.oracle.com. Em *Home Region* escolha **Brazil East (Sao Paulo)**
   (não dá para trocar depois, e perto de vocês o ping fica menor).
2. No painel: **Compute > Instances > Create instance**.
   - *Image*: **Canonical Ubuntu 24.04**.
   - *Shape*: **Ampere > VM.Standard.A1.Flex**, 1 OCPU e 6 GB (aparece "Always Free-eligible").
     Se der *Out of capacity*, tente outro *Availability domain*, tente de novo mais tarde, ou use
     **VM.Standard.E2.1.Micro** (também grátis, mais fraca, mas aguenta voz e tela para poucas pessoas).
   - *Add SSH keys*: **Generate a key pair** e clique em **Save private key** (guarde esse arquivo).
   - **Create**. Quando ficar verde (*Running*), copie o **Public IP address**.

## 3. Apontar o endereço para a VM

Volte no DuckDNS, cole o IP da VM no campo *current ip* do seu domínio e clique em **update ip**.

## 4. Abrir as portas na Oracle

Na página da instância: clique na **Subnet** > **Security** (ou *Security Lists*) > **Default Security List** >
**Add Ingress Rules**. Crie estas regras, todas com *Source CIDR* `0.0.0.0/0`:

| Protocolo | Porta (Destination Port Range) | Para quê |
|-----------|-------------------------------|----------|
| TCP | `80,443` | HTTPS (o `wss://`) |
| TCP | `7881` | mídia quando o UDP está bloqueado |
| UDP | `3478` | TURN, para redes mais fechadas |
| UDP | `50000-60000` | voz, câmera e tela (o normal) |

## 5. Instalar o servidor de voz

Na página da instância, clique em **Cloud Shell** (ou use o terminal do Windows com a chave do passo 2:
`ssh -i caminho\da\chave.key ubuntu@IP-DA-VM`). Dentro da VM, rode trocando o endereço pelo seu:

```bash
curl -fsSL https://raw.githubusercontent.com/LucasFort/Discord-2.0/main/voz/instalar.sh -o instalar.sh
sudo bash instalar.sh nexo-voz-lucas.duckdns.org
```

O script instala o Docker, libera as portas no firewall da própria VM, gera uma chave nova, liga o
LiveKit e o Caddy (que pega o certificado HTTPS grátis do Let's Encrypt) e no final mostra 3 linhas:

```
LIVEKIT_URL=wss://nexo-voz-lucas.duckdns.org
LIVEKIT_API_KEY=API...
LIVEKIT_API_SECRET=...
```

Se esquecer, rode o script de novo: ele mostra a mesma chave.

## 6. Trocar no Render

No Render, serviço **nexo > Environment**, troque `LIVEKIT_URL`, `LIVEKIT_API_KEY` e `LIVEKIT_API_SECRET`
pelos 3 valores acima e clique em **Save, rebuild and deploy**. Depois abra
`https://SEU-APP.onrender.com/api/voice-config`: precisa mostrar `"configured":true` e a URL nova.
Não precisa de app novo: o app de computador e o site pegam o endereço do servidor sozinhos.

## Se algo der errado

- **HTTPS não responde no fim do script:** o DuckDNS ainda não aponta para o IP certo, ou faltam as
  portas 80/443 no passo 4. Veja o log: `sudo docker compose -f /opt/nexo-voz/docker-compose.yml logs caddy`.
- **Entra na call mas ninguém se ouve:** faltam as portas UDP `50000-60000` ou TCP `7881` no passo 4.
  Log do LiveKit: `sudo docker compose -f /opt/nexo-voz/docker-compose.yml logs livekit`.
- **A VM parou sozinha:** a Oracle às vezes desliga VMs grátis que ficam quase sem uso por 7 dias.
  É só clicar em **Start** na página da instância (o IP continua o mesmo). Para isso nunca acontecer,
  dá para mudar a conta para *Pay As You Go*: continua de graça dentro dos limites Always Free.
- **Atualizar o LiveKit:** `cd /opt/nexo-voz && sudo docker compose pull && sudo docker compose up -d`.
