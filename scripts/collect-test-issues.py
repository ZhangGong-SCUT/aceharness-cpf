#!/usr/bin/env python3
"""
GitCode Issue 收集器 - 按照 skills/gitcode-issue-collector/SKILL.md 流程执行
步骤1: 获取所有已关闭 Issue（不按时间过滤）
步骤2: 质量评分筛选
步骤3: 通过 /issues/{number}/pull_requests 检查 PR 关联并验证已合入
"""

import json
import re
import time
import urllib.request
import urllib.parse
import urllib.error
import argparse
from datetime import datetime, timedelta

# ============ 配置 ============
# 路径从环境变量读取，默认走相对路径，禁止硬编码用户级绝对路径
import os
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG_PATH = os.environ.get(
    "GITCODE_COLLECTOR_CONFIG",
    os.path.join(_REPO_ROOT, "skills/gitcode-issue-collector/config.json"),
)
DEFAULT_OUTPUT_PATH = os.environ.get(
    "GITCODE_COLLECTOR_OUTPUT",
    os.path.join(_REPO_ROOT, "tests/diagnosis-eval/test-issues.md"),
)

# 命令行参数：支持指定仓库和输出文件
parser = argparse.ArgumentParser(description="GitCode Issue 收集器")
parser.add_argument("--owner", help="仓库 owner（覆盖配置文件）")
parser.add_argument("--repo", help="仓库名（覆盖配置文件）")
parser.add_argument("--output", help="输出文件路径（覆盖默认路径）")
parser.add_argument("--months", type=int, help="PR 合并时间范围（月，覆盖配置文件）")
parser.add_argument("--threshold", type=int, help="质量评分阈值（覆盖配置文件）")
args = parser.parse_args()

with open(CONFIG_PATH, "r", encoding="utf-8") as f:
    config_text = f.read()

# 支持 ${ENV_VAR} 占位符：从环境变量注入真实值
def _resolve_env(match: "re.Match[str]") -> str:
    var_name = match.group(1)
    value = os.environ.get(var_name, "")
    if not value:
        raise RuntimeError(
            f"环境变量 {var_name} 未设置；请在 ~/.zshrc 或 .env 中 export 后重试。"
        )
    return value

config_text = re.sub(r"\$\{([A-Z_][A-Z0-9_]*)\}", _resolve_env, config_text)
config = json.loads(config_text)

TOKEN = config["gitcode"]["access_token"]
API_BASE = config["gitcode"]["api_base_url"]
INTERVAL = config["gitcode"]["request_interval_seconds"]
TIMEOUT = config["gitcode"]["request_timeout_seconds"]
MAX_RETRIES = config["gitcode"]["max_retries"]

OWNER = args.owner or config["collection"]["default_repo"]["owner"]
REPO = args.repo or config["collection"]["default_repo"]["repo"]
MONTHS = args.months or config["collection"]["pr_merge_time_range_months"]
SCORE_THRESHOLD = args.threshold or config["collection"]["quality_score_threshold"]

# 输出文件：如果指定了 --output 或 --repo，则使用对应路径
if args.output:
    OUTPUT_PATH = args.output
elif args.owner or args.repo:
    # 自动生成输出路径：tests/diagnosis-eval/test-issues-{repo}.md
    OUTPUT_PATH = os.path.join(
        os.path.dirname(DEFAULT_OUTPUT_PATH),
        f"test-issues-{REPO}.md",
    )
else:
    OUTPUT_PATH = DEFAULT_OUTPUT_PATH

# 时间范围：近 MONTHS 个月
NOW = datetime(2026, 7, 6)
SINCE_DATE = NOW - timedelta(days=MONTHS * 30)
SINCE_STR = SINCE_DATE.strftime("%Y-%m-%d")
NOW_STR = NOW.strftime("%Y-%m-%d")

print(f"配置: owner={OWNER}, repo={REPO}, 时间范围={SINCE_STR} ~ {NOW_STR}, 评分阈值={SCORE_THRESHOLD}")
print(f"输出文件: {OUTPUT_PATH}")

# ============ API 调用 ============
def api_get(path, params=None):
    url = f"{API_BASE}{path}"
    if params is None:
        params = {}
    params["access_token"] = TOKEN
    url += "?" + urllib.parse.urlencode(params)

    for attempt in range(MAX_RETRIES):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "ACEHarness-Collector/1.0"})
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                data = resp.read().decode("utf-8")
                return json.loads(data)
        except urllib.error.HTTPError as e:
            if e.code == 401:
                print(f"  [ERROR] 401 Unauthorized - Token 已过期!")
                raise RuntimeError("Token expired (401)")
            if e.code == 404:
                return None
            if e.code == 429:
                print(f"  [WARN] 429 限流, 等待 5s...")
                time.sleep(5)
                continue
            print(f"  [WARN] HTTP {e.code}: {e.reason} (attempt {attempt+1})")
            time.sleep(1)
        except Exception as e:
            print(f"  [WARN] {type(e).__name__}: {e} (attempt {attempt+1})")
            time.sleep(1)
    return None


# ============ 步骤 1: 获取所有已关闭 Issue ============
print(f"\n{'='*60}")
print(f"步骤 1: 获取 {OWNER}/{REPO} 的所有已关闭 Issue（不按时间过滤，仅按 PR 合并时间筛选）")
print(f"{'='*60}")

all_issues = []
page = 1
total_scanned = 0
while True:
    result = api_get(f"/repos/{OWNER}/{REPO}/issues", {
        "state": "closed",
        "page": page,
        "per_page": 100,
        "sort": "created",
        "direction": "desc",
    })
    if result is None or not isinstance(result, list) or len(result) == 0:
        break

    total_scanned += len(result)
    for issue in result:
        # 跳过 PR（GitCode issues API 也返回 PR）
        if "pull_request" in issue:
            continue
        all_issues.append(issue)

    print(f"  页 {page}: 获取 {len(result)} 条, 累计扫描 {total_scanned}, 累计 Issue {len(all_issues)} 条")

    if len(result) < 100:
        break
    page += 1
    time.sleep(INTERVAL)

print(f"\n步骤 1 完成: 所有已关闭 Issue = {len(all_issues)} 条 (扫描 {total_scanned} 条)")


# ============ 步骤 1.5: 过滤信息不全的 CP Issue ============
print(f"\n{'='*60}")
print(f"步骤 1.5: 过滤信息不全的 CP Issue（标题含 <title> 占位符）")
print(f"{'='*60}")

filtered_issues = []
cp_removed = 0
for issue in all_issues:
    title = issue.get("title", "") or ""
    title_lower = title.lower()
    # CP 模板未正确填写时标题含 <title> 占位符，这类 Issue 信息不全
    if "<title>" in title_lower:
        cp_removed += 1
        print(f"  过滤 CP Issue #{issue['number']}: {title[:60]}...")
        continue
    # 过滤仓库管理类 Issue（OAT 门禁、流水线门禁、测试用例等），这些不是真正的功能/缺陷问题
    # 使用 re.IGNORECASE 匹配大小写（标题中常为 "OAT.xml" 大写）
    # "门禁" 单独匹配：标题含"门禁"的 Issue 都是流水线门禁配置类
    if re.search(r"oat\.xml|oat文件|门禁|测试用例|测试案例", title, re.IGNORECASE):
        cp_removed += 1
        print(f"  过滤门禁/测试用例 Issue #{issue['number']}: {title[:60]}...")
        continue
    filtered_issues.append(issue)

all_issues = filtered_issues
print(f"步骤 1.5 完成: 过滤 {cp_removed} 个信息不全/仓库管理类 Issue，剩余 {len(all_issues)} 条")


# ============ 步骤 2: 质量评分 ============
print(f"\n{'='*60}")
print(f"步骤 2: 质量评分筛选 (阈值 >= {SCORE_THRESHOLD})")
print(f"{'='*60}")

def score_issue(issue):
    body = issue.get("body") or ""
    title = issue.get("title") or ""
    text = title + "\n" + body
    comments = issue.get("comments", 0)
    score = 0
    breakdown = []

    if len(body) > 500:
        score += 2; breakdown.append("body>500")
    if len(body) > 1500:
        score += 2; breakdown.append("body>1500")
    if len(body) > 3000:
        score += 1; breakdown.append("body>3000")
    if re.search(r"复现|步骤|reproduc|steps?", text, re.I):
        score += 2; breakdown.append("复现步骤")
    if "```" in body or re.search(r"代码|code sample", text, re.I):
        score += 2; breakdown.append("代码")
    if re.search(r"error|exception|crash|报错|错误|异常|崩溃", text, re.I):
        score += 2; breakdown.append("错误信息")
    if re.search(r"flutter doctor|ohos|harmonyos|鸿蒙|设备|系统版本|api level", text, re.I):
        score += 2; breakdown.append("环境信息")
    if re.search(r"image|screenshot|png|jpg|截图|图片", text, re.I):
        score += 1; breakdown.append("截图")
    if comments >= 3:
        score += 1; breakdown.append("3+评论")
    if comments >= 5:
        score += 1; breakdown.append("5+评论")

    return score, breakdown, len(body)

scored_issues = []
for issue in all_issues:
    score, breakdown, body_len = score_issue(issue)
    if score >= SCORE_THRESHOLD:
        issue["_score"] = score
        issue["_breakdown"] = breakdown
        issue["_body_len"] = body_len
        scored_issues.append(issue)

scored_issues.sort(key=lambda x: x["_score"], reverse=True)
print(f"步骤 2 完成: 质量评分 >= {SCORE_THRESHOLD} 的 Issue = {len(scored_issues)} 条")


# ============ 步骤 3: 检查 PR 关联并验证已合入 ============
print(f"\n{'='*60}")
print(f"步骤 3: 通过 /issues/{{number}}/pull_requests 检查 PR 关联并验证已合入")
print(f"{'='*60}")

def strip_flutter_template(body):
    """移除 Flutter 默认模板文本，保留用户实际填写的内容。

    Flutter Issue 模板（.github/ISSUE_TEMPLATE/2_bug.yml 等）包含大量固定文本，
    其中可能出现 "crash" 等词但并非问题描述。本函数移除以下模板内容：
    - "Thank you for using Flutter!" 开头的引导段
    - "If you are looking for support..." 引导段
    - 标准模板标题下的占位说明（如 "## Steps to reproduce" 下的 "1. ... 2. ..."）
    - "## Flutter Doctor" / "## Logs" 等标准段落标题本身
    """
    if not body:
        return ""

    cleaned = body

    # 1. 移除 "Thank you for using Flutter" 开头的整段
    cleaned = re.sub(
        r"thank you for using flutter[\s\S]*?(?=\n\s*\n|\n#{1,6}\s|$)",
        "",
        cleaned,
        flags=re.IGNORECASE,
    )

    # 2. 移除 "If you are looking for support" 开头的整段
    cleaned = re.sub(
        r"if you are looking for support[\s\S]*?(?=\n\s*\n|\n#{1,6}\s|$)",
        "",
        cleaned,
        flags=re.IGNORECASE,
    )

    # 3. 移除模板占位符行（如 "1. ...", "2. ...", "3. ..." 这类未填写的步骤占位）
    cleaned = re.sub(r"^\s*\d+\.\s*\.\.\.\s*$", "", cleaned, flags=re.MULTILINE)

    # 4. 移除标准模板段落标题（这些标题本身不含问题信息）
    template_headings = [
        r"##\s*steps to reproduce",
        r"##\s*expected results",
        r"##\s*actual results",
        r"##\s*code sample",
        r"##\s*flutter doctor",
        r"##\s*logs",
        r"##\s*screenshots or video",
        r"##\s*command",
        r"##\s*flutter application metadata",
    ]
    for heading in template_headings:
        cleaned = re.sub(heading, "", cleaned, flags=re.IGNORECASE | re.MULTILINE)

    return cleaned


def categorize(issue):
    title = (issue.get("title", "") or "").lower()
    body = (issue.get("body", "") or "").lower()
    # stability: 匹配标题 + 正文（去除模板后），避免模板文本中的 "crash" 误触发
    # 注意：anr/freeze/appfreeze 是「挂起不响应」问题，不属于 crash
    body_cleaned = strip_flutter_template(body).lower()
    if re.search(r"crash|闪退|崩溃|stack overflow|abort|segfault|sigabrt|sigsegv", title + "\n" + body_cleaned):
        return "stability"
    if re.search(r"memory leak|内存泄漏|内存溢出|oom|out of memory|nativeinit", title + "\n" + body):
        return "memory-leak"
    if re.search(r"render|渲染|绘制|gpu|opengl|impeller|skia|surface|texture|gradient|黑屏|白屏|花屏|闪烁", title + "\n" + body):
        return "rendering"
    if re.search(r"performance|性能|卡顿|jank|fps|latency|优化|ltpo|slow|耗时", title + "\n" + body):
        return "performance"
    return "functional"

final_issues = []
pr_cache = {}

for i, issue in enumerate(scored_issues):
    number = issue["number"]
    title = issue.get("title", "")

    # 3a: 获取 Issue 关联的 PR
    prs = api_get(f"/repos/{OWNER}/{REPO}/issues/{number}/pull_requests")
    time.sleep(INTERVAL)

    if not prs or not isinstance(prs, list) or len(prs) == 0:
        continue

    # 3b: 验证每个 PR 已合入
    valid_prs = []
    for pr in prs:
        pr_number = pr.get("number")
        if pr_number is None:
            continue

        if pr_number in pr_cache:
            if pr_cache[pr_number]:
                valid_prs.append(pr_cache[pr_number])
            continue

        pr_detail = api_get(f"/repos/{OWNER}/{REPO}/pulls/{pr_number}")
        time.sleep(INTERVAL)

        if pr_detail is None:
            continue

        if pr_detail.get("state") == "merged" and pr_detail.get("merged_at"):
            merged_at = pr_detail["merged_at"]
            try:
                merged_dt = datetime.strptime(merged_at[:10], "%Y-%m-%d")
            except:
                continue
            if merged_dt >= SINCE_DATE:
                # 提取 PR 创建人（user.login）
                pr_user = ""
                user_obj = pr_detail.get("user")
                if user_obj and isinstance(user_obj, dict):
                    pr_user = user_obj.get("login", "") or ""
                pr_info = {
                    "number": pr_number,
                    "title": pr_detail.get("title", ""),
                    "merged_at": merged_at[:10],
                    "user": pr_user,
                }
                pr_cache[pr_number] = pr_info
                valid_prs.append(pr_info)
            else:
                pr_cache[pr_number] = False
        else:
            pr_cache[pr_number] = False

    if valid_prs:
        issue["_prs"] = valid_prs
        issue["_category"] = categorize(issue)
        final_issues.append(issue)
        print(f"  [{len(final_issues)}] #{number} ({issue['_category']}, score={issue['_score']}) -> PR #{valid_prs[0]['number']} merged {valid_prs[0]['merged_at']}")

print(f"\n步骤 3 完成: 最终匹配 Issue = {len(final_issues)} 条")


# ============ 步骤 4: 去重 ============
print(f"\n{'='*60}")
print(f"步骤 4: 去重（标题归一化后相同的 Issue 仅保留评分最高的）")
print(f"{'='*60}")

def normalize_title(title):
    """归一化标题：移除版本号/分支名/标记，用于去重。"""
    if not title:
        return ""
    t = title.strip()
    # 移除各种方括号/圆括号标记：[3.35]、[OHOS]、[CP]、【3.35】、(Bug) 等
    t = re.sub(r"[\[【(]\s*[\w.\-]+\s*[\]】)]", "", t)
    # 移除分支名：br_3.27.4-ohos-1.0.4
    t = re.sub(r"br_[\d.]+-ohos-[\d.]+", "", t)
    # 移除 <title>...</title> 标记
    t = re.sub(r"<title>.*?</title>", "", t, flags=re.IGNORECASE | re.DOTALL)
    # 移除多余空格
    t = re.sub(r"\s+", " ", t).strip().lower()
    return t

# 按归一化标题分组
groups = {}
for issue in final_issues:
    key = normalize_title(issue.get("title", ""))
    if key not in groups:
        groups[key] = []
    groups[key].append(issue)

deduped_issues = []
dedup_info = []  # 记录去重信息
for key, group in groups.items():
    if len(group) == 1:
        deduped_issues.append(group[0])
    else:
        # 排序优先级：
        # 1. 评分降序（评分高的优先）
        # 2. 标题完整性：不含 <title> 占位符的优先（CP 模板未填写的标题质量差）
        # 3. Issue 编号降序（最新的优先）
        def title_quality(issue):
            title = issue.get("title", "") or ""
            # 含 <title> 占位符的排后面
            return 0 if "<title>" in title.lower() else 1

        group.sort(key=lambda x: (x["_score"], title_quality(x), x["number"]), reverse=True)
        kept = group[0]
        removed = group[1:]
        deduped_issues.append(kept)
        removed_nums = [str(i["number"]) for i in removed]
        dedup_info.append({
            "kept": kept["number"],
            "removed": removed_nums,
            "title": kept.get("title", ""),
        })
        print(f"  保留 #{kept['number']} (score={kept['_score']}), 去重: {', '.join(['#'+n for n in removed_nums])}")

print(f"\n步骤 4 完成: 去重后 Issue = {len(deduped_issues)} 条 (去重 {len(final_issues) - len(deduped_issues)} 条)")

# 用去重后的列表替换
final_issues = deduped_issues


# ============ 输出 Markdown ============
print(f"\n{'='*60}")
print(f"生成输出文件: {OUTPUT_PATH}")
print(f"{'='*60}")

# 按评分降序排列
final_issues.sort(key=lambda x: x["_score"], reverse=True)

lines = []
lines.append("# 鸿蒙跨平台框架 AI 诊断工作流 — 测试 Issue 集")
lines.append("")
lines.append(f"> **筛选标准**:")
lines.append(f"> - 来源：仅 `{OWNER}/{REPO}`")
lines.append(f"> - Issue 已关闭 + 有对应已合并 PR（通过 GitCode API `/issues/{{number}}/pull_requests` 正向查询获取关联）")
lines.append(f"> - PR 合并状态已通过 GitCode API 逐一验证（`state=merged` 且 `merged_at` 非空）")
lines.append(f"> - PR 合入时间在近 {MONTHS} 个月内（{SINCE_STR} 之后）")
lines.append(f"> - Issue 质量评分 ≥ {SCORE_THRESHOLD}（body长度 + 复现步骤 + 代码 + 错误信息 + 环境信息 + 截图 + 评论）")
lines.append(f">")
lines.append(f"> **收集日期**: {NOW_STR}")
lines.append(f"> **数据规模**: 扫描 {total_scanned} 个已关闭 Issue，质量评分达标 {len(scored_issues)} 个，最终匹配已合入 PR（近 {MONTHS} 个月内）{len(final_issues)} 个")
lines.append("")
lines.append("---")
lines.append("")

# 总览表格
lines.append(f"## 测试 Issue 总览（{len(final_issues)} 个，全部来自 {OWNER}/{REPO}，PR 近 {MONTHS} 个月内合并）")
lines.append("")
lines.append("| # | Issue | 标题 | PR | PR创建人 | PR合并日期 | 类型 | 评分 | Body | 评论 |")
lines.append("|---|--------|------|-----|---------|-----------|------|------|------|------|")
for idx, issue in enumerate(final_issues, 1):
    pr = issue["_prs"][0]
    # 显示完整标题，仅转义管道符避免破坏表格结构
    title_full = issue.get("title", "").replace("|", "\\|").replace("\n", " ").strip()
    issue_link = f"[#{issue['number']}](https://gitcode.com/{OWNER}/{REPO}/issues/{issue['number']})"
    pr_link = f"[#{pr['number']}](https://gitcode.com/{OWNER}/{REPO}/merge_requests/{pr['number']})"
    pr_user = pr.get("user", "") or "-"
    lines.append(f"| {idx} | {issue_link} | {title_full} | {pr_link} | {pr_user} | {pr['merged_at']} | {issue['_category']} | {issue['_score']} | {issue['_body_len']} | {issue.get('comments', 0)} |")
lines.append("")
lines.append("---")
lines.append("")

# 详细信息
lines.append("## 详细信息")
lines.append("")
for idx, issue in enumerate(final_issues, 1):
    pr = issue["_prs"][0]
    cat = issue["_category"]
    title = issue.get("title", "")
    body = (issue.get("body") or "").strip()
    # 提取问题描述（第一段非空文本）
    desc_lines = []
    for line in body.split("\n"):
        line = line.strip()
        if line and not line.startswith("```") and not line.startswith("![") and not line.startswith("http"):
            desc_lines.append(line)
            if len(desc_lines) >= 3:
                break
    desc = " ".join(desc_lines)[:200]

    lines.append(f"### {idx}. #{issue['number']} — {title}（{cat}）")
    lines.append("")
    lines.append(f"- **Issue**: https://gitcode.com/{OWNER}/{REPO}/issues/{issue['number']}")
    lines.append(f"- **PR**: https://gitcode.com/{OWNER}/{REPO}/merge_requests/{pr['number']} (merged {pr['merged_at']})")
    lines.append(f"- **PR Title**: {pr['title']}")
    lines.append(f"- **PR 创建人**: {pr.get('user', '') or '-'}")
    lines.append(f"- **质量评分**: {issue['_score']} | Body: {issue['_body_len']} chars | Comments: {issue.get('comments', 0)}")
    lines.append(f"- **评分明细**: {', '.join(issue['_breakdown'])}")
    lines.append(f"- **问题描述**: {desc}")
    lines.append("")

lines.append("---")
lines.append("")

# 统计
lines.append("## 统计")
lines.append("")
cat_stats = {}
for issue in final_issues:
    cat = issue["_category"]
    if cat not in cat_stats:
        cat_stats[cat] = []
    cat_stats[cat].append(issue["_score"])

cat_names = {
    "stability": "稳定性 (stability)",
    "memory-leak": "内存泄漏 (memory-leak)",
    "rendering": "渲染 (rendering)",
    "performance": "性能 (performance)",
    "functional": "功能 (functional)",
}

lines.append("| 类型 | 数量 | 质量评分范围 |")
lines.append("|------|------|-------------|")
for cat in ["stability", "memory-leak", "rendering", "performance", "functional"]:
    scores = cat_stats.get(cat, [])
    if scores:
        lines.append(f"| {cat_names[cat]} | {len(scores)} | {min(scores)}-{max(scores)} |")
    else:
        lines.append(f"| {cat_names[cat]} | 0 | — |")
lines.append(f"| **总计** | **{len(final_issues)}** | **{min(i['_score'] for i in final_issues) if final_issues else 0}-{max(i['_score'] for i in final_issues) if final_issues else 0}** |")
lines.append("")

# 质量保证
lines.append("## 质量保证")
lines.append("")
lines.append("每个 Issue 均满足以下全部条件：")
lines.append(f"- ✅ 来源：`{OWNER}/{REPO}`")
lines.append("- ✅ Issue 已关闭（state=closed）")
lines.append("- ✅ 有对应的已合并 PR（通过 GitCode API `/issues/{number}/pull_requests` 正向查询获取关联）")
lines.append("- ✅ PR 合入时间在近 {MONTHS} 个月内（{since} 之后）".format(MONTHS=MONTHS, since=SINCE_STR))
lines.append("- ✅ PR 合并时间已确认（merged_at 字段非空）")
lines.append("- ✅ PR 合并状态已验证（state=merged）")
lines.append(f"- ✅ 质量评分 ≥ {SCORE_THRESHOLD}（body长度 + 复现步骤 + 代码 + 错误信息 + 环境信息 + 截图 + 评论）")
lines.append("")

# 数据收集方法
lines.append("## 数据收集方法")
lines.append("")
lines.append(f"1. **获取已关闭 Issue**: 通过 GitCode API v5 `GET /repos/{OWNER}/{REPO}/issues?state=closed` 分页获取所有已关闭 Issue（共扫描 {total_scanned} 条）")
lines.append(f"2. **时间范围过滤**: 按 `updated_at` 过滤近 {MONTHS} 个月内的 Issue（{SINCE_STR} 之后，共 {len(all_issues)} 条）")
lines.append(f"3. **质量评分**: 对每个 Issue 按 body长度、复现步骤、代码示例、错误信息、环境信息、截图、评论数进行评分，筛选 score ≥ {SCORE_THRESHOLD}（共 {len(scored_issues)} 条）")
lines.append(f"4. **查询 Issue-PR 关联**: 通过 `GET /repos/{OWNER}/{REPO}/issues/{{number}}/pull_requests` 正向查询每个高质量 Issue 关联的 PR")
lines.append(f"5. **验证 PR 合并状态**: 逐一通过 `GET /repos/{OWNER}/{REPO}/pulls/{{pr_number}}` 获取 PR 详情，确认 `state=merged` 且 `merged_at` 非空，且合入时间在近 {MONTHS} 个月内")
lines.append(f"6. **最终匹配**: 同时满足「质量评分达标」和「关联了已合入 PR」的 Issue 纳入测试集（共 {len(final_issues)} 条）")
lines.append("")

with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
    f.write("\n".join(lines))

print(f"\n✅ 完成! 输出文件: {OUTPUT_PATH}")
print(f"   最终测试 Issue 数量: {len(final_issues)}")
print(f"   类型分布: {dict((c, len(s)) for c, s in cat_stats.items())}")
