#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AIWeb 拉模式连通性测试 demo（在华为内网运行）
=================================================
用途：验证「内网 → 公网 AIWeb」的拉取链路是否畅通。
原理：模拟小鲁班定时轮询 AIWeb 的通知接口（GET /api/notify/pending），
      若能成功取回 JSON 事件列表，则拉模式方案可行。

使用：
  python3 aiweb_pull_demo.py

只需 Python 3.6+（标准库，无需 pip 安装任何依赖）。
"""

import json
import socket
import ssl
import sys
import time
import urllib.request
import urllib.error

# ── 配置（API Key 找 AIWeb 管理员获取） ─────────────────────────────────────
BASE_URL = "https://aiweb.cpf-manager.xyz"
API_KEY = "REPLACE_WITH_YOUR_NOTIFY_API_KEY"
TIMEOUT = 15  # 秒

# Cloudflare 会拦截 Python-urllib 默认 UA（error 1010），必须带自定义 UA
HEADERS = {"User-Agent": "XiaoLuBan-NotifyBot/1.0"}

PASS, FAIL = "✅", "❌"


def step(name, ok, detail=""):
    print("  {} {}{}".format(PASS if ok else FAIL, name, " — " + detail if detail else ""))
    return ok


def main():
    print("=" * 62)
    print(" AIWeb 拉模式连通性测试（内网 → 公网）")
    print(" 目标: {}".format(BASE_URL))
    print("=" * 62)

    host = BASE_URL.split("//", 1)[1]

    # ── 1. DNS 解析（内网 DNS 能否解析公网域名） ─────────────────────────
    print("\n[1/4] DNS 解析")
    try:
        infos = socket.getaddrinfo(host, 443, proto=socket.IPPROTO_TCP)
        ips = sorted({i[4][0] for i in infos})
        dns_ok = step("解析 {} 成功".format(host), True, "IP: {}".format(", ".join(ips[:3])))
        def _is_private(ip):
            if ip.startswith("10.") or ip.startswith("192.168."):
                return True
            if ip.startswith("172."):
                try:
                    return 16 <= int(ip.split(".")[1]) <= 31
                except ValueError:
                    return False
            return False
        if any(_is_private(ip) for ip in ips):
            print("      ⚠️ 解析到内网 IP（可能被内网代理劫持，结果仅供参考）")
    except socket.gaierror as e:
        dns_ok = step("解析 {} 失败".format(host), False, str(e))
        print("\n结论: DNS 不通 — 内网无法解析公网域名，拉模式不可行，需联系网络管理员。")
        return 1

    # ── 2. HTTPS 基础连通（无鉴权接口） ───────────────────────────────────
    print("\n[2/4] HTTPS 基础连通（GET /api/alive）")
    try:
        req = urllib.request.Request(BASE_URL + "/api/alive", headers=HEADERS, method="GET")
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            body = json.loads(resp.read().decode("utf-8"))
        alive_ok = step("HTTP {}".format(resp.status), resp.status == 200,
                        "服务存活: {}".format(body.get("alive", body.get("success", "?"))))
    except Exception as e:
        alive_ok = step("请求失败", False, "{}: {}".format(type(e).__name__, e))
        print("\n结论: HTTPS 不通 — 内网无法访问公网 AIWeb（检查防火墙/代理策略）。")
        return 1

    # ── 3. 鉴权拉取（带 X-Notify-Key，模拟小鲁班） ────────────────────────
    print("\n[3/4] 通知事件拉取（GET /api/notify/pending，带鉴权）")
    if API_KEY.startswith("REPLACE"):
        step("跳过（未配置 API_KEY）", True, "请编辑本文件填入 API_KEY 后重跑")
        print("\n结论: 基础链路已通！配置 API_KEY 后可测完整拉取。")
        return 0
    try:
        req = urllib.request.Request(
            BASE_URL + "/api/notify/pending",
            headers={**HEADERS, "X-Notify-Key": API_KEY, "Accept": "application/json"},
            method="GET",
        )
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        pending_ok = step("HTTP {}".format(resp.status), resp.status == 200,
                          "待通知事件: {} 条".format(data.get("count", "?")))
        for ev in data.get("events", [])[:5]:
            print("      · [{}] PR #{} | {} | {}".format(
                ev.get("type"), ev.get("prNumber"), ev.get("status"), ev.get("ownerName", "")))
    except urllib.error.HTTPError as e:
        pending_ok = step("HTTP {}".format(e.code), e.code in (200, 401),
                          "401=API Key 错误（链路本身是通的）" if e.code == 401 else e.reason)
    except Exception as e:
        pending_ok = step("请求失败", False, "{}: {}".format(type(e).__name__, e))

    # ── 4. TLS 证书与延迟观测 ─────────────────────────────────────────────
    print("\n[4/4] 链路质量")
    try:
        import time
        t0 = time.time()
        urllib.request.urlopen(urllib.request.Request(BASE_URL + "/api/alive", headers=HEADERS), timeout=TIMEOUT).read()
        rtt = int((time.time() - t0) * 1000)
        step("往返延迟 {}ms".format(rtt), rtt < 5000, "{}（<2000ms 适合分钟级轮询）".format("良好" if rtt < 2000 else "偏慢"))
    except Exception:
        pass
    try:
        ctx = ssl.create_default_context()
        conn = ctx.wrap_socket(socket.create_connection((host, 443), timeout=TIMEOUT), server_hostname=host)
        cert = conn.getpeercert()
        step("TLS 证书有效", True, "颁发给: {}".format(dict(x[0] for x in cert.get("subject", [])) .get("commonName", host)))
        conn.close()
    except Exception as e:
        step("TLS 检查失败", False, str(e)[:60])

    # ── 结论 ──────────────────────────────────────────────────────────────
    print("\n" + "=" * 62)
    if alive_ok:
        if pending_ok:
            print(" 结论: ✅ 拉模式完全可行 — 小鲁班可从内网轮询 AIWeb 通知接口")
        else:
            print(" 结论: ◐ 基础链路通 — 通知接口未通（多为 API Key 问题，找管理员核对）")
    else:
        print(" 结论: ❌ 链路不通 — 需网络管理员放行对 aiweb.cpf-manager.xyz 的访问")
    print("=" * 62)
    return 0


if __name__ == "__main__":
    sys.exit(main())
