#!/usr/bin/env python3
"""
Cloudflare Tunnel Watchdog — 检测公网可达性，断连时自动重启 cloudflared

原理：每 60 秒通过 Cloudflare 公网入口（绕过本地缓存）发起一次真实 HTTP 请求，
如果连续 N 次失败（排除偶发抖动），自动 systemctl --user restart cloudflared。

部署方式（systemd user service，开机自启）：
  mkdir -p ~/.config/systemd/user
  cp tunnel-watchdog.service ~/.config/systemd/user/
  systemctl --user daemon-reload
  systemctl --user enable --now tunnel-watchdog.service

日志：journalctl --user -u tunnel-watchdog -f
"""
import subprocess
import time
import urllib.request

# ── 配置 ──
CHECK_INTERVAL = 60          # 检测间隔（秒）
CHECK_URL = 'https://cpf-manager.xyz/api/runs'  # 用 AceHarness API（轻量、无需认证）
CHECK_TIMEOUT = 15            # 单次请求超时
FAIL_THRESHOLD = 3            # 连续失败 N 次才重启（防偶发抖动）
COOLDOWN = 300                # 重启后冷却期（秒），避免频繁重启
MAX_RESTARTS_PER_HOUR = 6     # 每小时最大重启次数（防死循环）
RESTART_TIMEOUT = 30         # systemctl 客户端等待上限；超时不代表服务端重启任务已取消

# ── 状态 ──
fail_count = 0
last_restart = None
restart_history = []  # 单调时钟下的重启尝试时间（成功、失败、超时都计入）


def log(msg, level='INFO'):
    ts = time.strftime('%H:%M:%S')
    print(f'[{ts}][{level}] {msg}', flush=True)


def check_tunnel():
    """通过公网入口发起真实请求，返回是否可达"""
    try:
        req = urllib.request.Request(
            CHECK_URL,
            headers={'User-Agent': 'tunnel-watchdog/1.0'},
        )
        with urllib.request.urlopen(req, timeout=CHECK_TIMEOUT) as resp:
            return resp.status == 200
    except Exception:
        return False


def restart_cloudflared():
    """发起重启；命令失败或超时均交回监控循环，不能让守护进程退出。"""
    try:
        result = subprocess.run(
            ['systemctl', '--user', 'restart', 'cloudflared.service'],
            capture_output=True, text=True, timeout=RESTART_TIMEOUT,
        )
    except subprocess.TimeoutExpired:
        log(f'重启命令等待超过 {RESTART_TIMEOUT}s；服务端任务可能仍在执行，进入冷却后继续监测', 'ERROR')
        return False
    except OSError as error:
        log(f'无法执行重启命令（{type(error).__name__}），进入冷却后继续监测', 'ERROR')
        return False
    if result.returncode != 0:
        log(f'重启命令返回非零退出码 {result.returncode}，进入冷却后继续监测', 'ERROR')
        return False
    return True


def verify_recovery(wait_seconds=20):
    """等待后验证是否恢复"""
    time.sleep(wait_seconds)
    return check_tunnel()


def check_once():
    """执行一轮探活与恢复决策；只有主循环负责轮询间隔。"""
    global fail_count, last_restart

    if check_tunnel():
        if fail_count > 0:
            log(f'恢复正常（此前连续失败 {fail_count} 次）')
        fail_count = 0
        return

    fail_count += 1
    log(f'公网不可达（连续第 {fail_count}/{FAIL_THRESHOLD} 次）', 'WARN')
    if fail_count < FAIL_THRESHOLD:
        return

    # 使用单调时钟，系统校时不应缩短冷却或延长每小时计数窗口。
    now = time.monotonic()
    if last_restart is not None and now - last_restart < COOLDOWN:
        remaining = int(COOLDOWN - (now - last_restart))
        log(f'冷却期内（剩 {remaining}s），跳过重启', 'WARN')
        return

    restart_history[:] = [t for t in restart_history if now - t < 3600]
    if len(restart_history) >= MAX_RESTARTS_PER_HOUR:
        log(f'本小时已尝试重启 {len(restart_history)} 次（上限 {MAX_RESTARTS_PER_HOUR}），暂停重启', 'ERROR')
        return

    # 在执行前预留预算：systemctl 超时后服务端任务仍可能执行，失败也不能无限重试。
    # 避免命令超时使守护退出、计数重置，或非零返回使每分钟都重启隧道。
    last_restart = now
    restart_history.append(now)
    log(f'连续 {fail_count} 次失败，执行重启 cloudflared（本小时第 {len(restart_history)} 次尝试）…', 'ERROR')
    if not restart_cloudflared():
        return

    log('重启命令完成，等待验证公网恢复')
    if verify_recovery():
        log('重启后隧道恢复 ✓')
        fail_count = 0
    else:
        log('重启后仍未恢复，进入冷却并继续监测', 'ERROR')


def main():
    log(f'Watchdog 启动：每 {CHECK_INTERVAL}s 检测 {CHECK_URL}')
    log(f'阈值：连续 {FAIL_THRESHOLD} 次失败 → 重启 | 冷却 {COOLDOWN}s | 每小时最多 {MAX_RESTARTS_PER_HOUR} 次尝试（失败/超时也计入）')

    while True:
        check_once()
        time.sleep(CHECK_INTERVAL)


if __name__ == '__main__':
    main()
