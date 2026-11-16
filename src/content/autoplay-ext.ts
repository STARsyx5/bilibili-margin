// 映间 MARGIN · 连播方式扩展（v0.61）
// 运行在页面主环境（MAIN world），document_idle。总开关由内容脚本写进
// localStorage['margin:autoplay-ext']，关闭时完全不介入，交还官方逻辑。

interface BiliPlayer {
  setHandoff?(value: number): void;
}

interface BiliVue {
  setContinuousPlay?(on: boolean): void;
  checkContinuousPlay?(): void;
}

type SceneKind = 'bangumi' | 'multiPage' | 'collection' | 'single';
type PrefKey = 'bangumi' | 'multiPage' | 'collection' | 'recommend';

interface SceneInfo {
  kind: SceneKind;
  pref: PrefKey;
  /** 到最后一集/最后一个分P 时为 false */
  ok: boolean;
}

interface Progress {
  current: number;
  total: number;
}

interface Prefs {
  collection: boolean;
  multiPage: boolean;
  bangumi: boolean;
  recommend: boolean;
}

(() => {
  'use strict';

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  async function waitFor<T>(fn: () => T | null | undefined | false, opts?: { timeout?: number; interval?: number }): Promise<T | null> {
    const timeout = opts?.timeout ?? 30000;
    const interval = opts?.interval ?? 250;
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try {
        const v = fn();
        if (v) return v;
      } catch { /* 继续等 */ }
      await sleep(interval);
    }
    return null;
  }

  const getPlayer = (): BiliPlayer | null =>
    (window as { player?: BiliPlayer }).player ?? null;

  function getVueRoot(): BiliVue | null {
    const app = document.getElementById('app') as (HTMLElement & Record<string, unknown>) | null;
    if (!app) return null;
    for (const k of ['__vue__', '__vue2__', '__vue3__']) {
      const vm = app[k];
      if (vm) return vm as BiliVue;
    }
    return null;
  }

  const Scene = {
    settle(): SceneKind {
      if (/\/bangumi\/play\/ep\d+/.test(location.pathname)) return 'bangumi';
      if (document.querySelector('.multip, .multi-page, .multi-page-v1')) return 'multiPage';
      // .section 是合集，没有 .section 的 .video-pod__list 是分P
      const podList = document.querySelector('.video-pod__list');
      if (podList && !document.querySelector('.video-pod__list.section')) return 'multiPage';
      if (document.querySelector('.video-pod__list.section, .base-video-sections, .base-video-sections-v1')) {
        return 'collection';
      }
      return 'single';
    },

    collectionProgress(): Progress | null {
      const el = document.querySelector('.video-pod__header .amt, .list-count');
      if (!el) return null;
      const m = (el.textContent ?? '').match(/(\d+)\s*\/\s*(\d+)/);
      return m ? { current: Number(m[1]), total: Number(m[2]) } : null;
    },

    bangumiProgress(): Progress | null {
      const links = document.querySelectorAll<HTMLAnchorElement>('a[href*="/bangumi/play/ep"]');
      if (!links.length) return null;
      const cur = (location.pathname.match(/ep(\d+)/) ?? [])[1];
      if (!cur) return null;

      // 番剧导航里 listItem 是 PV，numberItem 才是正片
      let total = 0;
      let current = 0;
      for (const a of links) {
        const holder = a.closest('[class*="EpisodeVirtualList_numberItem"], [class*="EpisodeVirtualList_listItem"]');
        if (!holder || /listItem/.test(String(holder.className))) continue;
        total++;
        if (current === 0) {
          const m = (a.getAttribute('href') ?? '').match(/ep(\d+)/);
          if (m && m[1] === cur) current = total;
        }
      }
      if (!total) return null;
      return { current, total };
    },
  };

  const EXT_KEY = 'margin:autoplay-ext';
  const EXT_EVENT = 'margin:autoplay-ext';
  const EXT_ATTR = 'data-margin-autoplay-ext';

  const readExtEnabled = (): boolean => {
    try {
      return localStorage.getItem(EXT_KEY) !== '0';
    } catch {
      return true;
    }
  };
  let extEnabled = readExtEnabled();

  /** 番剧页没有 #app / __vue__，用 player.setHandoff：0=自动切集 2=播完暂停 */
  function setBangumiHandoff(on: boolean): void {
    try {
      getPlayer()?.setHandoff?.(on ? 0 : 2);
    } catch { /* 忽略 */ }
  }

  function onExtChanged(): void {
    if (extEnabled) {
      AutoPlay.reset();
      AutoPlay.apply(true);
    } else if (Scene.settle() === 'bangumi') {
      setBangumiHandoff(true);
    } else {
      getVueRoot()?.checkContinuousPlay?.();
    }
    mountSettingSwitches();
  }

  /** 事件为主通道；属性与轮询兜底，防跨 world 时事件没穿透 */
  function listenExtChanges(): void {
    const sync = (incoming?: string): void => {
      const next = incoming === '0' ? false
                 : incoming === '1' ? true
                 : readExtEnabled();
      if (next === extEnabled) return;
      extEnabled = next;
      onExtChanged();
    };

    document.addEventListener(EXT_EVENT, (e) => {
      const detail = (e as CustomEvent<string>).detail;
      sync(typeof detail === 'string' ? detail : undefined);
    }, true);

    new MutationObserver(() => sync()).observe(document.documentElement, {
      attributes: true,
      attributeFilter: [EXT_ATTR],
    });

    setInterval(() => sync(), 5000);

    window.addEventListener('storage', (e) => {
      if (e.key === EXT_KEY) sync();
    });
  }

  const STORE_KEY = 'margin-patch:autoplay';
  const DEFAULTS: Prefs = {
    collection: true,
    multiPage: true,
    bangumi: true,
    recommend: false,
  };
  let prefs: Prefs = { ...DEFAULTS };
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null') as Partial<Prefs> | null;
    if (saved && typeof saved === 'object') prefs = { ...DEFAULTS, ...saved };
  } catch { /* 忽略损坏存储 */ }
  const savePrefs = (): void => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(prefs));
    } catch { /* 隐私模式 */ }
  };

  const AutoPlay = {
    lastState: null as boolean | null,

    current(): SceneInfo {
      const kind = Scene.settle();

      if (kind === 'bangumi') {
        const p = Scene.bangumiProgress();
        return { kind, pref: 'bangumi', ok: !!p && p.current > 0 && p.current < p.total };
      }
      if (kind === 'single') return { kind, pref: 'recommend', ok: true };

      const p = Scene.collectionProgress();
      return { kind, pref: kind, ok: !!p && p.current < p.total };
    },

    apply(force = false): void {
      if (!extEnabled) return;

      const s = this.current();
      const want = prefs[s.pref] && s.ok;

      if (!force && this.lastState === want) return;

      if (s.kind === 'bangumi') {
        setBangumiHandoff(want);
        this.lastState = want;
        return;
      }

      const vm = getVueRoot();
      if (typeof vm?.setContinuousPlay !== 'function') return;

      try {
        vm.setContinuousPlay(want);
        this.lastState = want;
      } catch { /* 忽略 */ }
    },

    reset(): void {
      this.lastState = null;
    },
  };

  const SWITCH_ITEMS: ReadonlyArray<{ key: PrefKey; label: string }> = [
    { key: 'collection', label: '合集连播' },
    { key: 'multiPage', label: '分P连播' },
    { key: 'bangumi', label: '番剧连播' },
    { key: 'recommend', label: '推荐连播' },
  ];

  /** 尺寸对齐 B 站原生 .bui-switch-body（30x20） */
  function makeSwitch({ key, label }: { key: PrefKey; label: string }): HTMLDivElement {
    const ROW_H = 32;
    const TRACK_W = 30;
    const TRACK_H = 20;
    const KNOB = 16;
    const TRAVEL = TRACK_W - KNOB - 4;

    const area = document.createElement('div');
    area.className = 'margin-patch-switch';
    area.dataset.pref = key;
    area.style.cssText = `display:flex;align-items:center;justify-content:space-between;
      width:100%;height:${ROW_H}px;padding:0 12px;box-sizing:border-box;cursor:pointer;`;

    const lab = document.createElement('span');
    lab.className = 'margin-patch-label';
    lab.textContent = label;
    lab.style.cssText = 'font-size:12px;color:#fff;line-height:1;flex:0 0 auto;';

    const track = document.createElement('span');
    track.className = 'margin-patch-track';
    track.style.cssText = `position:relative;display:inline-block;
      width:${TRACK_W}px;height:${TRACK_H}px;border-radius:${TRACK_H / 2}px;
      flex:0 0 auto;transition:background .18s ease;box-sizing:border-box;`;

    const knob = document.createElement('span');
    knob.className = 'margin-patch-knob';
    knob.style.cssText = `position:absolute;top:2px;left:2px;
      width:${KNOB}px;height:${KNOB}px;border-radius:50%;background:#fff;
      transition:transform .18s ease;box-sizing:border-box;`;
    track.append(knob);

    const paint = (on: boolean): void => {
      track.style.background = on ? '#00a1d6' : '#7f7f7f';
      knob.style.transform = on ? `translateX(${TRAVEL}px)` : 'translateX(0)';
    };
    paint(prefs[key]);

    area.append(lab, track);

    area.addEventListener('click', (e) => {
      e.stopPropagation();
      prefs[key] = !prefs[key];
      paint(prefs[key]);
      savePrefs();
      AutoPlay.apply(true);
    });

    return area;
  }

  /** 四个开关已覆盖官方「播放方式」，留着会跟着联动造成误解；只隐藏不删节点 */
  function hideNativeAutoPlayGroup(): void {
    const right = document.querySelector('.bpx-player-ctrl-setting-menu-right');
    if (!right) return;
    const target = right.querySelector<HTMLElement>('.bpx-player-ctrl-setting-handoff');
    if (!target) return;
    target.style.display = extEnabled ? 'none' : '';
  }

  function mountSettingSwitches(): boolean {
    const right = document.querySelector('.bpx-player-ctrl-setting-menu-right');
    if (!right) return false;

    hideNativeAutoPlayGroup();

    const existing = right.querySelector('.margin-patch-group');
    if (!extEnabled) {
      existing?.remove();
      return true;
    }
    if (existing) return true;

    const group = document.createElement('div');
    group.className = 'margin-patch-group';
    group.style.cssText = 'padding:8px 0 4px;';

    const title = document.createElement('div');
    title.textContent = '连播';
    title.style.cssText = 'padding:2px 0 6px;font-size:13px;opacity:.72;';
    group.append(title);

    for (const item of SWITCH_ITEMS) group.append(makeSwitch(item));

    right.append(group);
    return true;
  }

  /** 设置面板点击齿轮时才创建，需要等它出现再挂 */
  function watchSettingsButton(): void {
    document.addEventListener('click', (e) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      if (!t.closest('.bpx-player-ctrl-setting')) return;
      void waitFor(() => mountSettingSwitches(), { timeout: 3000, interval: 100 });
    }, true);

    let t2 = 0;
    const mo = new MutationObserver(() => {
      clearTimeout(t2);
      t2 = window.setTimeout(() => mountSettingSwitches(), 150);
    });
    const root = document.querySelector('.bpx-player-container');
    if (root) mo.observe(root, { childList: true, subtree: true });
  }

  function watchAutoplay(): void {
    const root = document.querySelector('.right-container, .playlist-container--right') ?? document.body;
    let timer = 0;
    const mo = new MutationObserver(() => {
      clearTimeout(timer);
      timer = window.setTimeout(() => AutoPlay.apply(), 200);
    });
    mo.observe(root, { childList: true, subtree: true });

    document.addEventListener('loadedmetadata', () => {
      AutoPlay.reset();
      setTimeout(() => AutoPlay.apply(true), 300);
    }, true);

    // B 站没有 getter 可读当前状态，播放中又可能自己改回去。
    // timeupdate 每秒触发多次，只在临近结尾时校准并做 1 秒节流。
    let lastCalib = 0;
    document.addEventListener('timeupdate', (e) => {
      const v = e.target;
      if (!(v instanceof HTMLVideoElement) || !v.duration) return;
      if (v.duration - v.currentTime > 15) return;
      const now = Date.now();
      if (now - lastCalib < 1000) return;
      lastCalib = now;
      AutoPlay.apply(true);
    }, true);

    document.addEventListener('ended', () => AutoPlay.apply(true), true);

    const onNav = (): void => {
      AutoPlay.reset();
      setTimeout(() => {
        AutoPlay.apply(true);
        mountSettingSwitches();
      }, 1000);
    };
    window.addEventListener('popstate', onNav);
    let lastHref = location.href;
    setInterval(() => {
      if (location.href !== lastHref) {
        lastHref = location.href;
        onNav();
      }
    }, 1500);
  }

  async function main(): Promise<void> {
    if (!await waitFor(getPlayer)) return;

    mountSettingSwitches();
    watchSettingsButton();
    listenExtChanges();
    watchAutoplay();

    AutoPlay.apply(true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => void main(), { once: true });
  } else {
    void main();
  }
})();