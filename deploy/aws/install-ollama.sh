#!/usr/bin/env bash
# Free, open-source model backend for Conjure: Ollama (MIT) serving an open-weight model
# on the same instance, bound to 127.0.0.1 only. No API key, and questions never leave the server.
# Run as root on the Conjure instance (via SSM). Safe to re-run.
set -euo pipefail

MODEL="${CONJURE_LLM_MODEL:-qwen2.5:1.5b}"

# 2 GB swap so a small instance can hold the model next to Node without the OOM killer.
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

if ! command -v ollama >/dev/null; then
  curl -fsSL https://ollama.com/install.sh | sh
fi

# Loopback only, one request at a time, keep the model loaded between calls.
install -d /etc/systemd/system/ollama.service.d
cat > /etc/systemd/system/ollama.service.d/conjure.conf <<'EOF'
[Service]
Environment=OLLAMA_HOST=127.0.0.1:11434
Environment=OLLAMA_NUM_PARALLEL=1
Environment=OLLAMA_MAX_LOADED_MODELS=1
Environment=OLLAMA_KEEP_ALIVE=-1
EOF
systemctl daemon-reload
systemctl enable --now ollama
systemctl restart ollama
for i in $(seq 30); do curl -sf http://127.0.0.1:11434/api/version >/dev/null && break; sleep 2; done
ollama pull "$MODEL"

# Point Conjure at it (replacing earlier values) and run one forecast at a time.
ENV=/etc/conjure/env
sed -i '/^CONJURE_LLM_URL=/d;/^CONJURE_LLM_MODEL=/d;/^CONJURE_PREDICT_CONCURRENCY=/d;/^CONJURE_MOCK=/d' "$ENV"
{
  echo "CONJURE_LLM_URL=http://127.0.0.1:11434/v1"
  echo "CONJURE_LLM_MODEL=$MODEL"
  echo "CONJURE_PREDICT_CONCURRENCY=1"
} >> "$ENV"
[ -n "${CONJURE_SKIP_RESTART:-}" ] || systemctl restart conjure
echo "ollama $(ollama --version | tail -1); model $MODEL ready"
