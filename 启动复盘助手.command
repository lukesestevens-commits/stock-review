#!/bin/zsh
set -e

SCRIPT_DIR="${0:A:h}"
cd "$SCRIPT_DIR"

REVIEW_URL="http://127.0.0.1:8787/"
TZZB_ACCOUNT_NAME="东方"
TZZB_URL="https://tzzb.10jqka.com.cn/pc/index.html#/myAccount/a/qAgMWG2"
EXPECTED_HELPER_VERSION="2026.07.10-sync-repair-r3"
BUNDLED_NODE="/Users/ruiqiwang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
HELPER_LOG_DIR="$SCRIPT_DIR/logs"
HELPER_LOG="$HELPER_LOG_DIR/tzzb-local-helper.log"
CLOUD_SYNC_ENV_FILE="$SCRIPT_DIR/云同步配置.env"
TERMINAL_WINDOW_ID="$(/usr/bin/osascript -e 'tell application "Terminal" to id of front window' 2>/dev/null || true)"

if [ -f "$CLOUD_SYNC_ENV_FILE" ]; then
  set -a
  source "$CLOUD_SYNC_ENV_FILE"
  set +a
fi

isHelperReady() {
  /usr/bin/curl -fsS "http://127.0.0.1:8787/api/tzzb-health" >/dev/null 2>&1
}

helperVersion() {
  /usr/bin/curl -fsS "http://127.0.0.1:8787/api/tzzb-health" 2>/dev/null \
    | /usr/bin/sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    | /usr/bin/head -n 1
}

isCurrentHelperReady() {
  [ "$(helperVersion)" = "$EXPECTED_HELPER_VERSION" ]
}

stopStaleHelper() {
  local runningVersion
  runningVersion="$(helperVersion || true)"
  if [ -z "$runningVersion" ] || [ "$runningVersion" = "$EXPECTED_HELPER_VERSION" ]; then
    return
  fi

  echo "检测到旧版本地服务（$runningVersion），正在重启为新版（$EXPECTED_HELPER_VERSION）。"
  local pids
  pids="$(/usr/sbin/lsof -ti tcp:8787 -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    /bin/kill $pids 2>/dev/null || true
    for _ in {1..20}; do
      if ! isHelperReady; then
        return
      fi
      sleep 0.2
    done
    /bin/kill -9 $pids 2>/dev/null || true
  fi
}

closeLauncherWindow() {
  if [ -z "$TERMINAL_WINDOW_ID" ]; then
    return
  fi

  (
    sleep 0.4
    /usr/bin/osascript >/dev/null 2>&1 <<APPLESCRIPT
tell application "Terminal"
  repeat with candidateWindow in windows
    if id of candidateWindow is ${TERMINAL_WINDOW_ID} then
      close candidateWindow
      exit repeat
    end if
  end repeat
end tell
APPLESCRIPT
  ) >/dev/null 2>&1 &
}

if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
elif [ -x "$BUNDLED_NODE" ]; then
  NODE_BIN="$BUNDLED_NODE"
else
  echo "未找到 Node.js，无法启动复盘助手。"
  read -k 1 "?按任意键关闭..."
  exit 1
fi

if "$NODE_BIN" --help 2>&1 | /usr/bin/grep -q -- '--use-env-proxy'; then
  export NODE_USE_ENV_PROXY=1
fi

echo "复盘助手正在启动：http://127.0.0.1:8787/"
echo "将先打开同花顺投资账本（$TZZB_ACCOUNT_NAME 账户），再打开复盘网站。"
echo "同花顺登录完成后，扩展会自动同步今天的资金、仓位、持仓和交易。"
if [ -n "${TZZB_CLOUD_SYNC_URL:-}" ]; then
  echo "已启用云端同步：$TZZB_CLOUD_SYNC_URL"
fi
echo ""

stopStaleHelper

if isCurrentHelperReady; then
  echo "本地服务已在运行且为最新版本，直接打开网页。"
else
  mkdir -p "$HELPER_LOG_DIR"
  echo "本地服务将在后台运行，日志写入：$HELPER_LOG"
  nohup "$NODE_BIN" tools/tzzb-local-helper.mjs >> "$HELPER_LOG" 2>&1 < /dev/null &
  SERVER_PID=$!
  disown "$SERVER_PID" 2>/dev/null || true
fi

for _ in {1..40}; do
  if isCurrentHelperReady; then
    open -a "Microsoft Edge" "$TZZB_URL" >/dev/null 2>&1 || open "$TZZB_URL" >/dev/null 2>&1 || true
    sleep 1
    open -a "Microsoft Edge" "$REVIEW_URL" >/dev/null 2>&1 || open "$REVIEW_URL" >/dev/null 2>&1 || true
    closeLauncherWindow
    exit 0
  fi
  sleep 0.25
done

echo "复盘助手启动超时，网页未自动打开。"
echo "请查看日志：$HELPER_LOG"
read -k 1 "?按任意键关闭..."
exit 1
