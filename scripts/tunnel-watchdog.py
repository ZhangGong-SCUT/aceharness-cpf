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
import json
import subprocess
import time
import urllib.request
import socket

# ── 配置 ──
CHECK_INTERVAL = 60          # 检测间隔（秒）
CHECK_URL = 'https://cpf-manager.xyz/api/runs'  # 用 AceHarness API（轻量、无需认证）
CHECK_TIMEOUT = 15            # 单次请求超时
FAIL_THRESHOLD = 3            # 连续失败 N 次才重启（防偶发抖动）
COOLDOWN = 300                # 重启后冷却期（秒），避免频繁重启
MAX_RESTARTS_PER_HOUR = 6     # 每小时最大重启次数（防死循环）

# ── 状态 ──
fail_count = 0
last_restart = 0
restart_history = []  # [timestamp, ...]


def log(msg, level='INFO'):
    ts = time.strftime('%H:%M:%S')
    print(f'[{ts}][{level}] {msg}', flush=True)


def check_tunnel():
    """通过公网入口发起真实请求，返回是否可达"""
    try:
        socket.setdefaulttimeout(CHECK_TIMEOUT)
        req = urllib.request.Request(
            CHECK_URL,
            headers={'User-Agent': 'tunnel-watchdog/1.0'},
        )
        resp = urllib.request.urlopen(req, timeout=CHECK_TIMEOUT)
        return resp.status == 200
    except Exception:
        return False


def restart_cloudflared():
    """重启 cloudflared 服务"""
    result = subprocess.run(
        ['systemctl', '--user', 'restart', 'cloudflared.service'],
        capture_output=True, text=True, timeout=30,
    )
    return result.returncode == 0


def verify_recovery(wait_seconds=20):
    """等待后验证是否恢复"""
    time.sleep(wait_seconds)
    return check_tunnel()


def main():
    global fail_count, last_restart

    log(f'Watchdog 启动：每 {CHECK_INTERVAL}s 检测 {CHECK_URL}')
    log(f'阈值：连续 {FAIL_THRESHOLD} 次失败 → 重启 | 冷却 {COOLDOWN}s | 每小时上限 {MAX_RESTARTS_PER_HOUR} 次')

    while True:
        # 检测
        ok = check_tunnel()

        if ok:
            if fail_count > 0:
                log(f'恢复正常（此前连续失败 {fail_count} 次）')
            fail_count = 0
        else:
            fail_count += 1
            log(f'公网不可达（连续第 {fail_count}/{FAIL_THRESHOLD} 次）', 'WARN')

            # 达到阈值 → 重启
            if fail_count >= FAIL_THRESHOLD:
                now = time.time()

                # 冷却期检查
                if now - last_restart < COOLDOWN:
                    remaining = int(COOLDOWN - (now - last_restart))
                    log(f'冷却期内（剩 {remaining}s），跳过重启', 'WARN')
                    time.sleep(CHECK_INTERVAL)
                    continue

                # 每小时重启次数检查
                restart_history[:] = [t for t in restart_history if now - t < 3600]
                if len(restart_history) >= MAX_RESTARTS_PER_HOUR:
                    log(f'本小时已重启 {len(restart_history)} 次（上限 {MAX_RESTARTS_PER_HOUR}），暂停重启', 'ERROR')
                    time.sleep(CHECK_INTERVAL)
                    continue

                # 执行重启
                log(f'连续 {fail_count} 次失败，执行重启 cloudflared…', 'ERROR')
                if restart_cloudflared():
                    last_restart = now
                    restart_history.append(now)
                    log(f'重启命令已发出（本小时第 {len(restart_history)} 次）')

                    # 验证恢复
                    if verify_recovery():
                        log('重启后隧道恢复 ✓')
                        fail_count = 0
                    else:
                        log('重启后仍未恢复，将继续监测', 'ERROR')
                else:
                    log('重启命令执行失败', 'ERROR')

        time.sleep(CHECK_INTERVAL)


if __name__ == '__main__':
    main()
