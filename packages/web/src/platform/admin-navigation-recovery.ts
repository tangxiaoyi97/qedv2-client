/**
 * An older learner service worker may serve its HTML for an /admin navigation.
 * Once this entry is current, never boot learner state for that URL. Try a
 * worker update and one document navigation, then leave an actionable page.
 * Already-cached older JavaScript cannot be patched retroactively; an old
 * installation may still require an initial worker update from the home page.
 */
export async function recoverAdminNavigation(): Promise<void> {
  document.title = 'QED2 · 更新管理入口';
  document.documentElement.lang = 'zh-CN';
  const host = document.getElementById('app');
  if (!host) return;
  const message = document.createElement('p');
  message.textContent = '正在更新独立管理入口…';
  const home = document.createElement('a');
  home.href = '/'; home.textContent = '打开学习主页以完成应用更新';
  const admin = document.createElement('a');
  admin.href = '/admin/index.html'; admin.textContent = '重新打开管理入口';
  host.replaceChildren(message);
  host.style.cssText = 'padding:32px;display:grid;gap:20px;font:16px/1.7 system-ui';
  try {
    if ('serviceWorker' in navigator) {
      const registration = await navigator.serviceWorker.getRegistration();
      if (registration) {
        await registration.update();
        if (registration.waiting) registration.waiting.postMessage({ type: 'SKIP_WAITING' });
        if (registration.installing || registration.waiting) {
          await new Promise<void>((done) => {
            const finish = () => { clearTimeout(timer); navigator.serviceWorker.removeEventListener('controllerchange', finish); done(); };
            const timer = setTimeout(finish, 8000);
            navigator.serviceWorker.addEventListener('controllerchange', finish, { once: true });
          });
        }
      }
    }
    const response = await fetch('/admin/index.html', { cache: 'no-store', credentials: 'omit', redirect: 'error' });
    const html = response.ok ? await response.text() : '';
    if (html.includes('id="admin-app"') && !new URLSearchParams(location.search).has('admin-recovery')) {
      location.replace('/admin/index.html?admin-recovery=1');
      return;
    }
  } catch { /* Offline or an older gateway: keep recovery explicit and bounded. */ }
  message.textContent = '旧的离线应用仍在接管此地址。请先打开学习主页并完成更新，再重新打开管理入口；也可以使用浏览器的强制刷新。';
  host.append(home, admin);
}
