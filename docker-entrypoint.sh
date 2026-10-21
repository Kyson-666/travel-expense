#!/bin/sh
# 容器入口：
#   1. 确保挂载卷 $DATA_DIR 存在
#   2. 首次启动从镜像 /opt/seed/routes.json 拷默认示例数据到挂载卷（不覆盖已有数据）
#   3. 启动后端 node server/app.js（端口 3000 由 PORT 控制；DATA_DIR 默认 /data）
#
# 日志策略：
#   - 后端 stdout/stderr 一边转回容器 stdout（docker logs 可实时看）
#   - 同时通过 tee 追加到 $DATA_DIR/logs/app.log（用户挂载卷即群晖 /volume1/docker/travel/logs/app.log）
#   - 修复部署运维痛点：docker logs 只保留容器最后一次启动的输出，滚屏丢失；
#     落盘文件保留历史所有输出，事后排查直接 `tail -n 500 /data/logs/app.log`
#
# 信号处理：
#   - docker stop 发 SIGTERM 给 entrypoint (PID 1)
#   - trap 转发给 node 子进程，node 优雅退出
#   - wait 把 node 退出码回传 docker

set -u

DATA_DIR="${DATA_DIR:-/data}"
LOG_DIR="$DATA_DIR/logs"
LOG_FILE="$LOG_DIR/app.log"

mkdir -p "$DATA_DIR" "$LOG_DIR"

# 首次启动写入默认示例数据（不覆盖）
if [ ! -f "$DATA_DIR/routes.json" ]; then
  cp /opt/seed/routes.json "$DATA_DIR/routes.json"
  echo "[entrypoint] seed routes.json -> $DATA_DIR/routes.json"
fi

# 启动标记
printf '[entrypoint %s] boot start (data=%s logs=%s)\n' \
  "$(date -u +%FT%TZ)" "$DATA_DIR" "$LOG_FILE" >> "$LOG_FILE"

# 启动后端：stdout/stderr 直接追加到 $LOG_FILE，再由 tail 镜像到容器 stdout。
# 不用 `node app.js | tee` 的原因：管道里 `$!` 取到的是 tee 而非 node，会导致
#   1) wait 拿到 tee 的退出码 —— node 崩溃时容器仍以 0 退出，重启策略与监控都看不到异常；
#   2) docker stop 的 SIGTERM 只打到 tee —— node 收不到信号，优雅关闭不会执行。
# tail 先启动（-n 0 只跟新增行），保证 node 最早几行输出也进入 docker logs。
tail -n 0 -f "$LOG_FILE" &
TAIL_PID=$!

node server/app.js "$@" >> "$LOG_FILE" 2>&1 &
NODE_PID=$!

# 信号转发：docker stop → entrypoint 收到 SIGTERM → 转发给 node，并等它自己退出
#   重启后 trap 被 shell 自动重置，所以只在这里装一次
trap 'kill -TERM "$NODE_PID" 2>/dev/null || true' TERM INT

# 循环 wait：被信号打断时 wait 会提前返回（128+sig），但此时 node 仍在关闭中；
# 必须继续 wait 到进程真正结束，才能拿到 node 自己的退出码（0=正常 / 非 0=异常）。
EXIT_CODE=0
while :; do
  wait "$NODE_PID"
  EXIT_CODE=$?
  kill -0 "$NODE_PID" 2>/dev/null || break
done

kill "$TAIL_PID" 2>/dev/null || true
wait "$TAIL_PID" 2>/dev/null || true

printf '[entrypoint %s] exit %s\n' "$(date -u +%FT%TZ)" "$EXIT_CODE" >> "$LOG_FILE"
exit "$EXIT_CODE"
