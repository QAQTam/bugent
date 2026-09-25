#!/usr/bin/env bash
#
# wsbox 核心机制验证脚本 —— 证明「外部工具改文件 → 真实工作区不受损 → 有 diff」
#
# 设计见 docs/workspace-ledger-sandbox.md。
#
# 本脚本只验证三件事（不做 CAS / 账本落库，那些在 Rust 引擎里）：
#   1. unprivileged userns 里能挂 overlayfs（bwrap 自己不行）
#   2. 沙箱内 python 把文件 truncate 成 0 字节时，真实工作区完好
#   3. lower + upper 能直接产出 unified diff
#
# 用法：bash scripts/wsbox-overlay-spike.sh [root-dir]

set -euo pipefail

ROOT=${1:-$(mktemp -d /tmp/wsbox-spike.XXXXXX)}
WS=$ROOT/workspace      # 真实工作区（lower，永不直接写入）
SES=$ROOT/session
LOW=$SES/lower          # 本脚本用拷贝当 lower，真实实现可直接用工作区
UPP=$SES/upper          # agent 的全部写入
WRK=$SES/work
MRG=$SES/merged         # overlay 挂载点

if ! command -v bwrap >/dev/null; then
  echo "需要 bubblewrap (bwrap)" >&2
  exit 1
fi

mkdir -p "$WS" "$LOW" "$UPP" "$WRK" "$MRG"

printf 'def important():\n    return 42\n\nKEY = "do-not-lose-me"\n' > "$WS/app.py"
printf 'hello\n' > "$WS/keep.txt"
cp -a "$WS/." "$LOW/"

export WSBOX_WS=$WS WSBOX_LOW=$LOW WSBOX_UPP=$UPP WSBOX_WRK=$WRK WSBOX_MRG=$MRG

# 在 userns + mountns 里挂 overlay，再让 bwrap 把 merged 绑到工作区路径。
# 注意：bwrap 自己不能 mount overlay（capabilities 被丢弃），必须由外层 unshare 承担。
run_call() {
  local name=$1 cmd=$2
  echo "--- call: $name"
  export WSBOX_CMD="$cmd"
  unshare -Ur -m -- bash -c '
    set -euo pipefail
    mount -t overlay overlay \
      -o "lowerdir=$WSBOX_LOW,upperdir=$WSBOX_UPP,workdir=$WSBOX_WRK" \
      "$WSBOX_MRG"
    exec bwrap --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp \
      --bind "$WSBOX_MRG" "$WSBOX_WS" --chdir "$WSBOX_WS" \
      --unshare-pid --die-with-parent -- bash -lc "$WSBOX_CMD"
  '
  echo "    upper 里现在有："
  find "$UPP" -mindepth 1 -maxdepth 1 -printf '      %f  (%y, %s bytes)\n'
}

echo "### 基线"
echo "    workspace/app.py = $(stat -c%s "$WS/app.py") bytes  sha=$(sha256sum "$WS/app.py" | cut -c1-12)"
echo

# 模拟：模型用 python 而不是 edit/apply_patch，锚定失败把文件写空
run_call "python 错误锚定，把 app.py 写空" \
  "python3 -c \"open('app.py','w').write('')\""

echo
echo "### 结果"
echo "    真实工作区 app.py = $(stat -c%s "$WS/app.py") bytes  sha=$(sha256sum "$WS/app.py" | cut -c1-12)  <- 完好"
echo "    upper/app.py      = $(stat -c%s "$UPP/app.py") bytes  <- 坏写入只存在于 upper"
echo
echo "### lower vs upper 的 diff（就是要回传给模型的那份账）"
diff -u "$LOW/app.py" "$UPP/app.py" | sed 's/^/    /' || true
echo

# 会话连续性 + 删除（验证 whiteout）+ 新增
run_call "第二次调用：读上次结果、新增、删除" \
  "cat app.py; echo new > added.txt; rm keep.txt; ls"

echo
echo "### whiteout（删除在 upper 里的表示）"
while IFS= read -r -d '' entry; do
  echo "    $(basename "$entry") -> char device $(stat -c '%t:%T' "$entry")  (0:0 即 whiteout)"
done < <(find "$UPP" -maxdepth 1 -type c -print0)

echo
echo "### 真实工作区始终未被触碰"
ls -la "$WS" | sed 's/^/    /'
