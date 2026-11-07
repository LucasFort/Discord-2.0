#!/usr/bin/env bash
# Instala o servidor de voz do Nexo (LiveKit + Caddy para o HTTPS) numa VM Ubuntu,
# pensado para a VM grátis da Oracle Cloud (Always Free, ARM ou x86).
#
# Uso:  sudo bash instalar.sh SEU-NOME.duckdns.org
#
# Pode rodar de novo quando quiser (atualiza tudo e mantém a mesma chave).
set -euo pipefail

DOMINIO="${1:-}"
if [ -z "$DOMINIO" ]; then
  echo "Uso: sudo bash instalar.sh SEU-NOME.duckdns.org" >&2
  exit 1
fi
if [ "$(id -u)" -ne 0 ]; then
  echo "Rode com sudo: sudo bash instalar.sh $DOMINIO" >&2
  exit 1
fi

PASTA=/opt/nexo-voz
mkdir -p "$PASTA"
cd "$PASTA"

echo "==> 1/5 Instalando o Docker (se ainda não tiver)"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker >/dev/null

echo "==> 2/5 Abrindo as portas no firewall da própria VM"
# A imagem Ubuntu da Oracle vem com regras de iptables que bloqueiam tudo menos o SSH.
abrir() { # protocolo porta(s)
  iptables -C INPUT -p "$1" --dport "$2" -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p "$1" --dport "$2" -j ACCEPT
}
abrir tcp 80          # Let's Encrypt (certificado do HTTPS)
abrir tcp 443         # site do LiveKit com HTTPS (wss://)
abrir tcp 7881        # mídia por TCP (quando o UDP está bloqueado)
abrir udp 3478        # TURN (redes mais fechadas)
abrir udp 50000:60000 # mídia por UDP (o normal)
if command -v netfilter-persistent >/dev/null 2>&1; then
  netfilter-persistent save >/dev/null 2>&1 || true
else
  DEBIAN_FRONTEND=noninteractive apt-get install -y iptables-persistent >/dev/null 2>&1 || true
  netfilter-persistent save >/dev/null 2>&1 || true
fi

echo "==> 3/5 Gerando a chave (ou mantendo a que já existe)"
if [ -f chave.env ]; then
  # shellcheck disable=SC1091
  . ./chave.env
else
  API_KEY="API$(head -c 64 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 12)"
  API_SECRET="$(head -c 96 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 43)"
  printf 'API_KEY=%s\nAPI_SECRET=%s\n' "$API_KEY" "$API_SECRET" > chave.env
  chmod 600 chave.env
fi

echo "==> 4/5 Escrevendo a configuração"
cat > livekit.yaml <<YAML
port: 7880
log_level: info
rtc:
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 60000
  # Descobre o IP público sozinho (a VM da Oracle só enxerga o IP interno).
  use_external_ip: true
turn:
  enabled: true
  domain: ${DOMINIO}
  udp_port: 3478
keys:
  ${API_KEY}: ${API_SECRET}
YAML
chmod 600 livekit.yaml

cat > Caddyfile <<CADDY
${DOMINIO} {
  reverse_proxy 127.0.0.1:7880
}
CADDY

cat > docker-compose.yml <<'COMPOSE'
services:
  livekit:
    image: livekit/livekit-server:latest
    command: --config /etc/livekit.yaml
    network_mode: host
    volumes:
      - ./livekit.yaml:/etc/livekit.yaml:ro
    restart: unless-stopped
  caddy:
    image: caddy:2
    network_mode: host
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
    restart: unless-stopped
volumes:
  caddy_data:
COMPOSE

echo "==> 5/5 Ligando o servidor"
docker compose pull -q
docker compose up -d

echo "Esperando o certificado HTTPS..."
OK=0
for _ in $(seq 1 30); do
  if curl -fsS -m 5 "https://${DOMINIO}" >/dev/null 2>&1; then OK=1; break; fi
  sleep 4
done

echo
if [ "$OK" = 1 ]; then
  echo "Pronto! O servidor de voz está no ar."
else
  echo "O servidor ligou, mas o HTTPS ainda não respondeu. Confira se o domínio aponta para o IP"
  echo "desta VM e se as portas estão abertas na Oracle (veja voz/README.md). Log: sudo docker compose -f $PASTA/docker-compose.yml logs caddy"
fi
echo
echo "Cole estes 3 valores no Render (serviço nexo > Environment):"
echo
echo "  LIVEKIT_URL=wss://${DOMINIO}"
echo "  LIVEKIT_API_KEY=${API_KEY}"
echo "  LIVEKIT_API_SECRET=${API_SECRET}"
echo
