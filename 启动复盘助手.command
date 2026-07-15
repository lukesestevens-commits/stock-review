#!/bin/zsh
set -e

SCRIPT_DIR="${0:A:h}"
cd "$SCRIPT_DIR"

LAUNCH_MODE="${1:-manual}"
REVIEW_URL="https://rqw-tzzb-review.lukesestevens.chatgpt.site"
TZZB_ACCOUNT_NAME="东方"
TZZB_URL="https://tzzb.10jqka.com.cn/pc/index.html#/myAccount/a/qAgMWG2"
EXPECTED_HELPER_VERSION="2026.07.15-daily-review-private-r12"
BUNDLED_NODE="/Users/ruiqiwang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
HELPER_LOG_DIR="$SCRIPT_DIR/logs"
HELPER_LOG="$HELPER_LOG_DIR/tzzb-local-helper.log"
if [ -f "$SCRIPT_DIR/cloud-sync.env" ]; then
  CLOUD_SYNC_ENV_FILE="$SCRIPT_DIR/cloud-sync.env"
else
  CLOUD_SYNC_ENV_FILE="$SCRIPT_DIR/云同步配置.env"
fi
LAUNCH_AGENT_LABEL="com.stockreview.tzzb-autocapture"
LAUNCH_AGENT_TEMPLATE="$SCRIPT_DIR/tools/${LAUNCH_AGENT_LABEL}.plist.template"
HELPER_AGENT_LABEL="com.stockreview.tzzb-helper"
HELPER_AGENT_TEMPLATE="$SCRIPT_DIR/tools/${HELPER_AGENT_LABEL}.plist.template"
LAUNCH_AGENT_DIR="$HOME/Library/LaunchAgents"
LAUNCH_AGENT_PLIST="$LAUNCH_AGENT_DIR/${LAUNCH_AGENT_LABEL}.plist"
HELPER_AGENT_PLIST="$LAUNCH_AGENT_DIR/${HELPER_AGENT_LABEL}.plist"
LAUNCH_RUNTIME_DIR="$HOME/.stock-review-runtime"
LAUNCH_PROJECT_DIR="$HOME/.stock-review-runtime/app"
LAUNCH_HELPER_PATH="$HOME/.stock-review-runtime/app/launch-helper.command"
TERMINAL_WINDOW_ID="$(/usr/bin/osascript -e 'tell application "Terminal" to id of front window' 2>/dev/null || true)"

if [ -f "$CLOUD_SYNC_ENV_FILE" ]; then
  set -a
  source "$CLOUD_SYNC_ENV_FILE"
  set +a
fi

configureSystemProxy() {
  if [ -n "${HTTPS_PROXY:-}${https_proxy:-}" ]; then
    return
  fi

  local proxy_config proxy_enabled proxy_host proxy_port
  proxy_config="$(/usr/sbin/scutil --proxy 2>/dev/null || true)"
  proxy_enabled="$(printf '%s\n' "$proxy_config" | /usr/bin/awk '/HTTPSEnable :/ { print $3; exit }')"
  proxy_host="$(printf '%s\n' "$proxy_config" | /usr/bin/awk '/HTTPSProxy :/ { print $3; exit }')"
  proxy_port="$(printf '%s\n' "$proxy_config" | /usr/bin/awk '/HTTPSPort :/ { print $3; exit }')"
  if [ "$proxy_enabled" = "1" ] && [ -n "$proxy_host" ] && [ -n "$proxy_port" ]; then
    export HTTPS_PROXY="http://${proxy_host}:${proxy_port}"
    export HTTP_PROXY="$HTTPS_PROXY"
    export https_proxy="$HTTPS_PROXY"
    export http_proxy="$HTTP_PROXY"
    export NO_PROXY="${NO_PROXY:-localhost,127.0.0.1,::1}"
    export no_proxy="$NO_PROXY"
  fi
}

renderLaunchAgent() {
  local template="$1"
  local destination="$2"
  local escaped_project escaped_launch_project escaped_launch_helper escaped_log temporary
  escaped_project="$(printf '%s' "$SCRIPT_DIR" | /usr/bin/sed 's/[&|]/\\&/g')"
  escaped_launch_project="$(printf '%s' "$LAUNCH_PROJECT_DIR" | /usr/bin/sed 's/[&|]/\\&/g')"
  escaped_launch_helper="$(printf '%s' "$LAUNCH_HELPER_PATH" | /usr/bin/sed 's/[&|]/\\&/g')"
  escaped_log="$(printf '%s' "$LAUNCH_PROJECT_DIR/logs" | /usr/bin/sed 's/[&|]/\\&/g')"
  temporary="${destination}.tmp.$$"
  /usr/bin/sed \
    -e "s|__PROJECT_DIR__|${escaped_project}|g" \
    -e "s|__LAUNCH_PROJECT_DIR__|${escaped_launch_project}|g" \
    -e "s|__LAUNCH_HELPER__|${escaped_launch_helper}|g" \
    -e "s|__LOG_DIR__|${escaped_log}|g" \
    "$template" > "$temporary"
  if [ -f "$destination" ] && /usr/bin/cmp -s "$temporary" "$destination"; then
    /bin/rm -f "$temporary"
    return 1
  fi
  /bin/mv -f "$temporary" "$destination"
  /bin/chmod 600 "$destination"
  return 0
}

installRuntimeMirror() {
  mkdir -p "$LAUNCH_RUNTIME_DIR" "$LAUNCH_PROJECT_DIR" "$LAUNCH_PROJECT_DIR/logs"
  /bin/chmod 700 "$LAUNCH_RUNTIME_DIR" "$LAUNCH_PROJECT_DIR"

  if [ ! -d "$LAUNCH_PROJECT_DIR/data/tzzb" ] && [ -d "$SCRIPT_DIR/data/tzzb" ]; then
    mkdir -p "$LAUNCH_PROJECT_DIR/data"
    /usr/bin/ditto "$SCRIPT_DIR/data/tzzb" "$LAUNCH_PROJECT_DIR/data/tzzb"
  fi

  /usr/bin/ditto "$SCRIPT_DIR/tools" "$LAUNCH_PROJECT_DIR/tools"
  /bin/cp -f "$SCRIPT_DIR/index.html" "$LAUNCH_PROJECT_DIR/index.html"
  /bin/cp -f "$SCRIPT_DIR/启动复盘助手.command" "$LAUNCH_HELPER_PATH"
  /bin/chmod 700 "$LAUNCH_HELPER_PATH" "$LAUNCH_PROJECT_DIR/tools/tzzb-scheduled-capture.command"

  if [ -f "$SCRIPT_DIR/云同步配置.env" ]; then
    /bin/cp -f "$SCRIPT_DIR/云同步配置.env" "$LAUNCH_PROJECT_DIR/cloud-sync.env"
    /bin/chmod 600 "$LAUNCH_PROJECT_DIR/cloud-sync.env"
  fi

  /bin/rm -f "$LAUNCH_RUNTIME_DIR/project" "$LAUNCH_RUNTIME_DIR/launch-helper.command"
}

installLaunchAgent() {
  local label="$1"
  local template="$2"
  local plist="$3"
  local service_domain changed
  service_domain="gui/$(/usr/bin/id -u)"
  changed=0
  if renderLaunchAgent "$template" "$plist"; then
    changed=1
  fi

  if /bin/launchctl print "${service_domain}/${label}" >/dev/null 2>&1; then
    if [ "$changed" = "0" ]; then
      if [ "$label" = "$HELPER_AGENT_LABEL" ]; then
        /bin/launchctl kickstart -k "${service_domain}/${label}" >/dev/null 2>&1 || true
      fi
      return 0
    fi
    /bin/launchctl bootout "${service_domain}/${label}" >/dev/null 2>&1 || true
  elif [ "$label" = "$HELPER_AGENT_LABEL" ]; then
    # Take ownership from an older manually detached helper before launchd supervises it.
    local pids
    pids="$(/usr/sbin/lsof -ti tcp:8787 -sTCP:LISTEN 2>/dev/null || true)"
    if [ -n "$pids" ]; then
      /bin/kill $pids 2>/dev/null || true
      sleep 0.3
    fi
  fi

  /bin/launchctl bootstrap "$service_domain" "$plist" >/dev/null 2>&1
}

installCaptureSchedule() {
  if [ ! -f "$LAUNCH_AGENT_TEMPLATE" ] || [ ! -f "$HELPER_AGENT_TEMPLATE" ]; then
    echo "未找到完整的登录启动或自动补抓模板，已跳过安装。"
    return
  fi

  installRuntimeMirror
  mkdir -p "$LAUNCH_AGENT_DIR" "$HELPER_LOG_DIR"
  if installLaunchAgent "$HELPER_AGENT_LABEL" "$HELPER_AGENT_TEMPLATE" "$HELPER_AGENT_PLIST"; then
    echo "已安装本地 helper 常驻服务，登录后自动启动，异常退出后自动恢复。"
  else
    echo "本地 helper 常驻服务加载失败，本次将使用后台备用方式启动。"
  fi

  "$NODE_BIN" "$LAUNCH_PROJECT_DIR/tools/tzzb-review-schedule.mjs" --mark-current >/dev/null 2>&1 || true
  if installLaunchAgent "$LAUNCH_AGENT_LABEL" "$LAUNCH_AGENT_TEMPLATE" "$LAUNCH_AGENT_PLIST"; then
    echo "已安装收盘自动补抓，登录或唤醒后会补跑最新已到期交易日。"
  else
    echo "收盘自动补抓加载失败，本次仍会正常启动复盘助手。"
  fi
}

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

isHelperAgentLoaded() {
  /bin/launchctl print "gui/$(/usr/bin/id -u)/${HELPER_AGENT_LABEL}" >/dev/null 2>&1
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

configureSystemProxy

if [ "$LAUNCH_MODE" = "manual" ]; then
  installCaptureSchedule
fi

if "$NODE_BIN" --help 2>&1 | /usr/bin/grep -q -- '--use-env-proxy'; then
  export NODE_USE_ENV_PROXY=1
fi

if [ "$LAUNCH_MODE" = "--daemon" ]; then
  mkdir -p "$HELPER_LOG_DIR"
  exec "$NODE_BIN" tools/tzzb-local-helper.mjs
fi

echo "复盘助手正在启动，本地 helper 监听于 http://127.0.0.1:8787/"
if [ "$LAUNCH_MODE" = "manual" ]; then
  echo "将先打开同花顺投资账本（$TZZB_ACCOUNT_NAME 账户），再打开正式私有复盘网站。"
else
  echo "收盘定时补抓只会打开同花顺投资账本。"
fi
echo "同花顺登录完成后，扩展会按交易日自动同步资金、仓位、持仓和交易。"
if [ -n "${TZZB_CLOUD_SYNC_URL:-}" ]; then
  echo "已启用云端同步：$TZZB_CLOUD_SYNC_URL"
fi
echo ""

stopStaleHelper

for _ in {1..100}; do
  if isCurrentHelperReady; then
    break
  fi
  sleep 0.1
done

if isCurrentHelperReady; then
  echo "本地服务已在运行且为最新版本，直接打开网页。"
elif isHelperAgentLoaded; then
  echo "helper 常驻服务已加载，但尚未就绪；不再启动第二个进程以避免端口冲突。"
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
    if [ "$LAUNCH_MODE" != "--scheduled" ]; then
      sleep 1
      open -a "Microsoft Edge" "$REVIEW_URL" >/dev/null 2>&1 || open "$REVIEW_URL" >/dev/null 2>&1 || true
    fi
    closeLauncherWindow
    exit 0
  fi
  sleep 0.25
done

echo "复盘助手启动超时，网页未自动打开。"
echo "请查看日志：$HELPER_LOG"
read -k 1 "?按任意键关闭..."
exit 1
