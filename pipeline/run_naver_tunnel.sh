#!/usr/bin/env bash
# 네이버 실매물 프록시 + Cloudflare quick tunnel(무계정·무도메인) 동시 실행.
# trycloudflare URL은 재시작마다 바뀜 → 출력된 URL을 대시보드 PricePopover의
# "⚙ 프록시 URL"에 한 번 붙여넣으면 localStorage에 저장되어 다음부터 자동 사용.
# URL은 클립보드에도 복사됨(pbcopy). Ctrl+C로 둘 다 종료.
#
# 사용: bash pipeline/run_naver_tunnel.sh
# 의존: python3 + curl_cffi, cloudflared (brew install cloudflared)
set -euo pipefail
cd "$(dirname "$0")/.."

PY="${PYTHON:-/Library/Frameworks/Python.framework/Versions/3.13/bin/python3}"
PORT="${PORT:-8787}"
LOGDIR="$HOME/Library/Logs/home-scoring"
mkdir -p "$LOGDIR"

cleanup() { kill "${PROXY_PID:-}" "${TUN_PID:-}" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

# 1) 프록시 (이미 떠 있으면 재사용)
if ! curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  PORT="$PORT" "$PY" pipeline/naver_proxy.py > "$LOGDIR/naver-proxy.log" 2>&1 &
  PROXY_PID=$!
  for _ in $(seq 1 15); do curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break; sleep 1; done
  echo "✓ 프록시 기동 (pid $PROXY_PID)"
else
  echo "✓ 프록시 이미 실행 중 (port $PORT)"
fi

# 2) quick tunnel
TLOG="$LOGDIR/naver-tunnel.log"; : > "$TLOG"
cloudflared tunnel --url "http://localhost:$PORT" --no-autoupdate > "$TLOG" 2>&1 &
TUN_PID=$!
URL=""
for _ in $(seq 1 30); do
  URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TLOG" 2>/dev/null | head -1)"
  [ -n "$URL" ] && break
  sleep 1
done
if [ -z "$URL" ]; then echo "✗ 터널 URL 추출 실패 — $TLOG 확인" >&2; exit 1; fi

command -v pbcopy >/dev/null && printf '%s' "$URL" | pbcopy && COPIED=" (클립보드 복사됨)" || COPIED=""
echo
echo "════════════════════════════════════════════════════════════"
echo " 프록시 URL$COPIED:"
echo "   $URL"
echo " → 대시보드 PricePopover의 '⚙ 프록시 URL'에 붙여넣고 저장"
echo " → Ctrl+C 로 종료"
echo "════════════════════════════════════════════════════════════"
wait "$TUN_PID"
