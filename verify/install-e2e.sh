#!/usr/bin/env bash
# 端到端复现：在**隔离 DSH_HOME** 里走一遍真实的装链路（不碰 ~/.dsh）。
#
# 做三件事：
#   1. 从 shipped headless 模板初始化一个临时 profile；
#   2. `dsh plugin --profile <name> add <本包目录>`（与 `/plugin install <abs path>`
#      同一个宿主服务 ctx.pluginManager）；
#   3. `dsh --profile <name> --dump-config` 确认 bundle patch 里的行进了组合树，
#      再空跑一次 boot（会因没有凭证在 AUTH 处失败，但足够证明行激活、工具注册）。
#
# 用法：bash verify/install-e2e.sh [隔离 HOME 目录，默认 ${TMPDIR:-/tmp}/dsh-tui-btw-todo-e2e/home]
#
# 注：sandbox 里 pnpm 的全局 store（~/.local/share/pnpm）不可写，所以这里把
# store/cache/state 都指到工作区内；正常机器上不需要这些环境变量。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG="$(cd "$HERE/.." && pwd)"
HOME_DIR="${1:-${TMPDIR:-/tmp}/dsh-tui-btw-todo-e2e/home}"
PROFILE=probe
WORK_DIR="$(dirname "$HOME_DIR")"

export DSH_HOME="$HOME_DIR"
# store/cache/state 固定在 HOME_DIR 的同级：sandbox 里 pnpm 的全局 store
# （~/.local/share/pnpm）不可写，而且 pnpm 会因为 store 换位置拒绝复用旧
# node_modules。正常机器上这几个变量不需要。
export npm_config_store_dir="${npm_config_store_dir:-$WORK_DIR/pnpm-store}"
export npm_config_cache="${npm_config_cache:-$WORK_DIR/.npm-cache}"
export npm_config_state_dir="${npm_config_state_dir:-$WORK_DIR/.pnpm-state}"
export XDG_DATA_HOME="${XDG_DATA_HOME:-$WORK_DIR/.xdg}"

echo "== 0. 隔离 HOME: $DSH_HOME"
mkdir -p "$DSH_HOME"

if [ ! -f "$HOME_DIR/profiles/$PROFILE/package.json" ]; then
  echo "== 1. 初始化 profile（shipped headless 模板）"
  dsh --profile "$PROFILE" --from-default-profile headless --dump-config > "$HOME_DIR/init.log" 2>&1
fi

echo "== 2. 真实安装：dsh plugin --profile $PROFILE add $PKG"
dsh plugin --profile "$PROFILE" add "$PKG" 2>&1 | tail -8

echo "== 3. profile 现状"
node -e "console.log(require('$HOME_DIR/profiles/$PROFILE/package.json'))"

echo "== 4. bundle patch 是否进了组合树"
dsh --profile "$PROFILE" --dump-config 2>/dev/null | grep -A 3 -B 1 'dsh-tui-btw-todo' || {
  echo "!! 组合树里没有本插件的行"; exit 1;
}

echo "== 5. 空跑一次 boot（无凭证，预期停在 AUTH）"
# 打开 debug 才有一行激活诊断：默认 debug:false，正常运行时 stderr 保持安静。
node -e "
const fs=require('fs'); const p='$HOME_DIR/profiles/$PROFILE/cordis.patch.yml';
let s=fs.readFileSync(p,'utf8').replace(/^\[\]\s*$/m,'');
if (!s.includes('id: btw-todo')) s += '- id: btw-todo\n  config:\n    debug: true\n';
fs.writeFileSync(p,s)"
DEEPSEEK_API_KEY=dummy-key-for-probe dsh --profile "$PROFILE" "say hi" > "$HOME_DIR/boot.out" 2> "$HOME_DIR/boot.err" || true
grep -n 'btw-todo' "$HOME_DIR/boot.err" || { echo "!! 没看到插件激活诊断"; exit 1; }

echo
echo "e2e: PASS（激活诊断见 $HOME_DIR/boot.err）"
