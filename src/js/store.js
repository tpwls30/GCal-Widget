(function () {
  const STORAGE_KEY = 'gcalWidgetStore.v1';

  const DEFAULTS = {
    settings: {
      opacity: 0.9,
      startOfWeek: 0,            // 0 = 일요일, 1 = 월요일
      view: 'month',             // 'month' | 'week' | 'day'
      showLunar: true,
      showSolarTerms: true,
      hideOtherMonthDays: false,
      showCompletedEvents: true,
      holidayColor: '#e5484d',
      sundayColor: '#e5484d',
      saturdayColor: '#3b82f6',
      weekdayColor: '#e6e6e6',
      calendarId: 'primary',
      fontFamily: 'default',
      fontScale: 1,
      groupGap: 8, // 하루종일 일정 묶음과 시간 지정 일정 묶음 사이 간격(px)
      // Wallpaper Engine에는 실제 OS 창이 없어서, 위젯의 위치/크기를 직접 기억해둬야 합니다.
      widgetX: 40,
      widgetY: 40,
      widgetWidth: 360,
      widgetHeight: 460
    },
    googleTokens: null,
    googleAccountEmail: null,
    localEvents: [],
    holidayCache: {},
    holidayCalendarId: null,
    completedEvents: {}
  };

  function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }

  function deepMerge(base, override) {
    if (!override || typeof override !== 'object') return base;
    for (const key of Object.keys(override)) {
      const v = override[key];
      if (v && typeof v === 'object' && !Array.isArray(v) && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
        deepMerge(base[key], v);
      } else {
        base[key] = v;
      }
    }
    return base;
  }

  function loadAll() {
    const base = deepClone(DEFAULTS);
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return base;
      return deepMerge(base, JSON.parse(raw));
    } catch (e) {
      console.warn('저장소 로드 실패, 기본값 사용:', e);
      return base;
    }
  }

  let data = loadAll();

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      console.warn('저장소 쓰기 실패:', e);
    }
  }

  function get(path) {
    const parts = path.split('.');
    let cur = data;
    for (const p of parts) {
      if (cur == null) return undefined;
      cur = cur[p];
    }
    return cur;
  }

  function set(path, value) {
    const parts = path.split('.');
    let cur = data;
    for (let i = 0; i < parts.length - 1; i++) {
      if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] == null) cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
    persist();
  }

  window.Store = { get, set };
})();
