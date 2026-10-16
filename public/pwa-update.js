// Small, testable coordinator for a user-controlled PWA reload.
((global) => {
  function createPwaUpdateCoordinator({ build, sessionStorage, reload, confirm, getRisks, isRestoreBlocked, onAvailable, onBlocked }) {
    const marker = `flashdesk-sw-reloaded-${build}`;
    let available = false;
    let reloadRequested = false;

    function controllerChanged() {
      available = true;
      onAvailable?.();
    }

    function apply() {
      if (!available || reloadRequested) return false;
      if (isRestoreBlocked?.()) {
        onBlocked?.('检测到未完成的备份恢复，请先完成恢复处理后再更新。');
        return false;
      }
      const risks = getRisks?.() || [];
      if (risks.length && !confirm('当前还有未保存内容，更新会重新载入页面。是否继续？')) return false;
      if (sessionStorage?.getItem(marker) === '1') return false;
      reloadRequested = true;
      sessionStorage?.setItem(marker, '1');
      reload();
      return true;
    }

    return { controllerChanged, apply, isAvailable: () => available };
  }

  const api = { createPwaUpdateCoordinator };
  global.FlashPwaUpdate = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
