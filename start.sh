#!/bin/bash
# TimeTracker Pro — pornire cu un singur script.
cd "$(dirname "$0")"
set -e

MODEL="${TT_MODEL:-qwen2.5:7b-instruct}"

echo "⏱  TimeTracker Pro"
echo

# 1. dependențe
if [ ! -d node_modules ]; then echo "→ Instalez dependențele (o singură dată)…"; npm install; fi

# 2. Ollama (AI local, gratuit) — opțional dar recomandat
if command -v ollama >/dev/null 2>&1; then
  if ! curl -s http://localhost:11434/api/tags >/dev/null 2>&1; then
    echo "→ Pornesc Ollama în fundal…"; ollama serve >/tmp/ollama.log 2>&1 & sleep 2
  fi
  if ! ollama list 2>/dev/null | grep -q "${MODEL%%:*}"; then
    echo "→ Descarc modelul $MODEL (o singură dată, ~4-5GB)…"
    ollama pull "$MODEL"
  fi
  echo "✓ Ollama gata · model $MODEL"
else
  echo "⚠  Ollama nu e instalat — aplicația merge, dar comenzile vocale și rapoartele AI"
  echo "   vor fi inactive. Instalează de pe https://ollama.com apoi: ollama pull $MODEL"
fi

echo
echo "→ Pornesc serverul…"
open http://localhost:5555 2>/dev/null || true
exec npm start
