#!/usr/bin/env bash
# Регистрирует go-scss-host как Native Messaging host для Chrome/Chromium.
# Использование: native-host/install.sh <ID расширения из chrome://extensions>
set -euo pipefail

EXT_ID="${1:-}"
if [[ ! "$EXT_ID" =~ ^[a-p]{32}$ ]]; then
  echo "Укажи ID расширения (32 буквы a-p) из chrome://extensions" >&2
  exit 1
fi

HOST_NAME="com.gaba.go_scss"
HOST_BIN="$HOME/go/bin/go-scss-host"

if [[ ! -x "$HOST_BIN" ]]; then
  echo "Нет $HOST_BIN — собери: cd ~/Documents/go/go-scss && go build -o $HOST_BIN ./cmd/go-scss-host" >&2
  exit 1
fi

MANIFEST=$(cat <<JSON
{
  "name": "$HOST_NAME",
  "description": "go-scss: конвертация CSS из Figma",
  "path": "$HOST_BIN",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
JSON
)

installed=0
for dir in "$HOME/.config/google-chrome" "$HOME/.config/chromium"; do
  if [[ -d "$dir" ]]; then
    mkdir -p "$dir/NativeMessagingHosts"
    printf '%s\n' "$MANIFEST" > "$dir/NativeMessagingHosts/$HOST_NAME.json"
    echo "Записано: $dir/NativeMessagingHosts/$HOST_NAME.json"
    installed=1
  fi
done

if [[ $installed -eq 0 ]]; then
  echo "Не найден ни ~/.config/google-chrome, ни ~/.config/chromium" >&2
  exit 1
fi
echo "Готово. Перезагрузи расширение в chrome://extensions."
