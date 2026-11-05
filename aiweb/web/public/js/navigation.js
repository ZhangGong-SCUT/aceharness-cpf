/* ── 导航切换 & URL Hash 状态持久化 ── */

/* ── 字体缩放控制 ── */

/**
 * 设置字体缩放系数
 * @param {number} scale - 缩放系数：1(标准) / 1.15(大) / 1.3(超大)
 */
function setFontScale(scale) {
  document.documentElement.style.setProperty('--font-scale', scale);
  localStorage.setItem('font-scale', String(scale));

  // 更新按钮激活态
  document.querySelectorAll('.font-scale-btn').forEach(btn => {
    btn.classList.toggle('active', parseFloat(btn.dataset.scale) === scale);
  });
}

/**
 * 页面加载时恢复用户字体偏好
 */
function initFontScale() {
  const saved = parseFloat(localStorage.getItem('font-scale'));
  const scale = [1, 1.15, 1.3].includes(saved) ? saved : 1;
  setFontScale(scale);
}

/** 切换到指定面板（更新激活样式 + 显示/隐藏） */
function switchToPanel(panelId) {
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const navItem = document.querySelector(`.nav-item[data-panel="${panelId}"]`);
  if (navItem) navItem.classList.add('active');

  document.querySelectorAll('#main > .panel').forEach(p => {
    p.style.display = p.id === panelId ? '' : 'none';
  });

  // 通知各面板可见性变化（如 PR 监控面板据此启停自己的轮询定时器）
  window.dispatchEvent(new CustomEvent('panelswitch', { detail: { panelId } }));

  // Issue 分析面板无需 SKILL 介绍，仅初始化 URL 校验
}

document.querySelectorAll('.nav-item').forEach(el => {
  el.addEventListener('click', () => {
    const panelId = el.dataset.panel;
    switchToPanel(panelId);
    // 将当前面板写入 URL Hash，刷新后仍可恢复
    history.replaceState(null, '', `#${panelId}`);
  });
});

// 页面加载时：字体缩放 + 访问统计 + Session统计 + 健康检查 + 并行恢复各类任务历史 + 恢复 Hash 导航状态
window.addEventListener('load', async () => {
  initFontScale();           // 字体缩放（同步，优先恢复用户偏好）
  initVisitStats();  // 访问统计（不阻塞，异步加载）
  initSessionStats();  // Session 调用统计（不阻塞，异步加载）
  doHealth();  // 健康检查（不阻塞，UI 无需等待）
  startSemaphorePolling();  // 信号量状态轮询（每 5s 更新）
  initAuth();  // 登录态初始化（header 用户区 + token 校验，不阻塞）

  // 历史任务加载
  await Promise.allSettled([
    initIssueAnalysisHistory(),
    initPrReviewHistory(),
  ]);

  // 恢复 URL Hash 指定的面板（刷新/分享链接时保持上下文）
  const hash = location.hash.slice(1);  // 去掉前缀 '#'
  if (hash) {
    const target = document.getElementById(hash);
    if (target && target.classList.contains('panel')) {
      switchToPanel(hash);
    }
  }
});
