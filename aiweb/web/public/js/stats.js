/* ── 访问统计模块 ── */

let _visitCount = 0;
let _sessionCount = 0;  // Session 调用次数

/**
 * 页面加载时获取访问统计
 */
async function initVisitStats() {
  try {
    const r = await apiFetch('GET', '/api/stats/visit');
    if (r.status === 200 && r.data?.success && r.data?.data) {
      _visitCount = r.data.data.visitCount;
      updateVisitStatsDisplay(_visitCount);
    } else {
      console.warn('访问统计响应异常:', r);
      updateVisitStatsDisplay('--');
    }
  } catch (e) {
    console.warn('获取访问统计失败:', e.message);
    updateVisitStatsDisplay('--');
  }
}

/**
 * 页面加载时获取 Session 调用统计
 */
async function initSessionStats() {
  try {
    const r = await apiFetch('GET', '/api/stats/session/count');
    if (r.status === 200 && r.data?.success && r.data?.data) {
      _sessionCount = r.data.data.sessionCount;
      updateSessionStatsDisplay(_sessionCount);
    } else {
      console.warn('Session 统计响应异常:', r);
      updateSessionStatsDisplay('--');
    }
  } catch (e) {
    console.warn('获取 Session 统计失败:', e.message);
    updateSessionStatsDisplay('--');
  }
}

/**
 * 更新访问统计显示
 */
function updateVisitStatsDisplay(count) {
  const countEl = $('visit-count');
  if (countEl) {
    if (typeof count === 'number') {
      countEl.textContent = formatVisitCount(count);
    } else {
      countEl.textContent = count;
    }
  }
}

/**
 * 格式化访问计数（大数字显示优化）
 */
function formatVisitCount(count) {
  if (count >= 10000) {
    return (count / 10000).toFixed(1) + 'w';
  } else if (count >= 1000) {
    return (count / 1000).toFixed(1) + 'k';
  }
  return count.toString();
}

/**
 * 数字动画效果（从0增长到目标值）
 */
function animateVisitCount(targetCount) {
  const countEl = $('visit-count');
  if (!countEl || typeof targetCount !== 'number') return;
  
  const duration = 800; // 动画持续时间 ms
  const startTime = performance.now();
  const startCount = 0;
  
  function animate(currentTime) {
    const elapsed = currentTime - startTime;
    const progress = Math.min(elapsed / duration, 1);
    
    // 缓动函数：easeOutExpo
    const easeProgress = 1 - Math.pow(2, -10 * progress);
    const currentCount = Math.floor(startCount + (targetCount - startCount) * easeProgress);
    
    countEl.textContent = formatVisitCount(currentCount);
    
    if (progress < 1) {
      requestAnimationFrame(animate);
    } else {
      countEl.textContent = formatVisitCount(targetCount);
    }
  }
  
  requestAnimationFrame(animate);
}

/**
 * 更新 Session 调用统计显示
 */
function updateSessionStatsDisplay(count) {
  const countEl = $('session-count');
  if (countEl) {
    if (typeof count === 'number') {
      countEl.textContent = formatVisitCount(count);  // 使用相同的格式化函数
    } else {
      countEl.textContent = count;
    }
  }
}

/**
 * Session 调用次数动画效果
 */
function animateSessionCount(targetCount) {
  const countEl = $('session-count');
  if (!countEl || typeof targetCount !== 'number') return;
  
  const duration = 800;
  const startTime = performance.now();
  const startCount = 0;
  
  function animate(currentTime) {
    const elapsed = currentTime - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const easeProgress = 1 - Math.pow(2, -10 * progress);
    const currentCount = Math.floor(startCount + (targetCount - startCount) * easeProgress);
    
    countEl.textContent = formatVisitCount(currentCount);
    
    if (progress < 1) {
      requestAnimationFrame(animate);
    } else {
      countEl.textContent = formatVisitCount(targetCount);
    }
  }
  
  requestAnimationFrame(animate);
}