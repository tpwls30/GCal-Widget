console.log('[app.js] 스크립트 로드/실행 시작', new Date().toISOString());

const state = {
  current: new Date(),
  view: 'month',
  settings: null,
  holidaysByYear: {},
  events: [],
  completedMap: {},
  editingEvent: null,
  selectedDay: null
};

const WEEKDAY_KO = ['일', '월', '화', '수', '목', '금', '토'];

const CalendarMath = {
  lunarLabel: (y, m, d) => LunarCalendar.formatLunar(LunarCalendar.solarToLunar(new Date(y, m - 1, d))),
  solarTerm: (y, m, d) => SolarTerms.getSolarTermForDate(y, m, d)
};

// Wallpaper Engine 환경에서는 브라우저 기본 alert()의 확인 버튼이 클릭되지 않는
// 문제가 있어서(포커스/입력 처리 관련 제약), 같은 모달 스타일로 직접 구현한 알림창을 씁니다.
function showMessage(text, title) {
  document.getElementById('msgModalTitle').textContent = title || '알림';
  document.getElementById('msgModalText').textContent = text;
  document.getElementById('msgModal').classList.remove('hidden');
}
function closeMessage() {
  document.getElementById('msgModal').classList.add('hidden');
}
document.getElementById('msgModalOk').addEventListener('click', closeMessage);

// Wallpaper Engine는 배경화면 웹페이지로는 마우스 휠(스크롤) 이벤트를 아예 전달하지
// 않습니다(보안상의 이유로 공식적으로 미지원 - 왼쪽 클릭과 드래그만 전달됨). 그래서
// 스크롤이 필요한 영역은 전부 "눌러서 위아래로 끄는" 방식으로 직접 구현했습니다.
let scrollDragMoved = false;
function initDragToScroll(container) {
  let dragging = false, startY = 0, startScrollTop = 0;
  container.addEventListener('mousedown', (e) => {
    dragging = true;
    startY = e.clientY;
    startScrollTop = container.scrollTop;
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const dy = e.clientY - startY;
    if (Math.abs(dy) > 4) scrollDragMoved = true;
    container.scrollTop = startScrollTop - dy;
  });
  window.addEventListener('mouseup', () => { dragging = false; });
}

// Wallpaper Engine에서 브라우저 배경화면으로 띄우면, 마우스 입력이 WE 쪽에서 합성되어
// 전달되기 때문에 네이티브 'dblclick' 이벤트가 아예 안 잡히는 경우가 있습니다(일반 클릭은
// 정상 동작하는 것과 대조적). 그래서 더블클릭이 필요한 곳은 전부 'click' 두 번을 직접
// 타이밍으로 감지하는 방식으로 바꿨습니다.
function onDoubleClick(el, handler) {
  let lastTime = 0;
  el.addEventListener('click', (e) => {
    if (scrollDragMoved) { scrollDragMoved = false; return; } // 방금 드래그로 스크롤한 거라면 클릭으로 취급하지 않음
    const now = Date.now();
    if (now - lastTime < 450) {
      lastTime = 0;
      handler(e);
    } else {
      lastTime = now;
    }
  });
}

// confirm()도 WE에서 동작하지 않아 같은 방식으로 대체합니다.
// 사용법: showConfirm('삭제할까요?', () => { 실제로 삭제하는 코드 });
let confirmCallback = null;
function showConfirm(text, onConfirm, title) {
  document.getElementById('confirmModalTitle').textContent = title || '확인';
  document.getElementById('confirmModalText').textContent = text;
  confirmCallback = onConfirm;
  document.getElementById('confirmModal').classList.remove('hidden');
}
document.getElementById('confirmModalOk').addEventListener('click', () => {
  document.getElementById('confirmModal').classList.add('hidden');
  const cb = confirmCallback;
  confirmCallback = null;
  if (cb) cb();
});
document.getElementById('confirmModalCancel').addEventListener('click', () => {
  document.getElementById('confirmModal').classList.add('hidden');
  confirmCallback = null;
});

function pad2(n) { return String(n).padStart(2, '0'); }
function dateKey(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function sameDay(a, b) { return dateKey(a) === dateKey(b); }
function startOfDay(d) { const n = new Date(d); n.setHours(0,0,0,0); return n; }
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }

function orderedWeekdays() {
  const start = state.settings.startOfWeek || 0;
  const arr = [];
  for (let i = 0; i < 7; i++) arr.push(WEEKDAY_KO[(start + i) % 7]);
  return arr;
}

function weekdayColor(jsWeekday) {
  if (jsWeekday === 0) return state.settings.sundayColor;
  if (jsWeekday === 6) return state.settings.saturdayColor;
  return state.settings.weekdayColor;
}

async function ensureHolidays(year) {
  if (state.holidaysByYear[year]) return state.holidaysByYear[year];
  try {
    const list = await GoogleCalendar.listHolidays(year);
    const map = {};
    list.forEach(h => { map[h.date] = h.name; });
    state.holidaysByYear[year] = map;
    return map;
  } catch (e) {
    console.warn('[app] 공휴일 조회 실패, 공휴일 없이 계속 진행합니다:', e);
    state.holidaysByYear[year] = {};
    return {};
  }
}

async function loadEventsForRange(min, max) {
  try {
    state.events = await GoogleCalendar.listEvents(min.getTime(), max.getTime());
  } catch (e) {
    console.warn('[app] 일정 조회 실패, 빈 목록으로 계속 진행합니다:', e);
    state.events = [];
  }
}

// 일정 추가/수정/삭제 후 구글 캘린더에 다시 목록 조회(네트워크 왕복)를
// 하지 않고, 방금 서버가 반환한 결과만 로컬 state.events에 반영합니다.
// 이렇게 하면 화면 갱신 시 불필요한 네트워크 호출이 줄어 반응 속도가 빨라집니다.
function upsertLocalEvent(ev) {
  const idx = state.events.findIndex(e => e.id === ev.id);
  if (idx >= 0) state.events[idx] = ev;
  else state.events.push(ev);
}
function removeLocalEvent(id) {
  state.events = state.events.filter(e => e.id !== id);
}

function eventsOnDay(d) {
  const dayStart = startOfDay(d).getTime();
  const dayEnd = dayStart + 86400000;
  return state.events.filter(e => e.start < dayEnd && e.end > dayStart);
}

// 달력 그리드(월/주)에 보여줄 목록: '완료된 일정 표시' 설정이 꺼져 있으면
// 완료된 일정은 그리드에서 숨깁니다(상세 목록에서는 계속 보여서 해제할 수 있게 함).
function visibleEventsOnDay(d) {
  const all = eventsOnDay(d);
  if (state.settings && state.settings.showCompletedEvents === false) {
    return all.filter(e => !state.completedMap[e.id]);
  }
  return all;
}

function isCompleted(ev) { return !!state.completedMap[ev.id]; }

function holidayPseudoEvent(d) {
  const holidayMap = state.holidaysByYear[d.getFullYear()] || {};
  const name = holidayMap[dateKey(d)];
  if (!name) return null;
  const dayStart = startOfDay(d).getTime();
  return {
    id: 'holiday-' + dateKey(d),
    title: name,
    start: dayStart,
    end: dayStart + 86400000,
    allDay: true,
    isHoliday: true
  };
}

const EVENT_COLOR_PALETTE = ['#5b8def','#ef6461','#f5b942','#34a853','#a855f7','#06b6d4','#ec4899','#f97316','#84cc16','#6366f1'];
function eventColor(ev) {
  const key = String(ev.id || ev.title || '');
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return EVENT_COLOR_PALETTE[hash % EVENT_COLOR_PALETTE.length];
}

// 하루 종일 일정을 맨 위로, 그 다음은 시작 시간 순으로 정렬
function sortEventsForDisplay(evs) {
  return [...evs].sort((a, b) => {
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
    return a.start - b.start;
  });
}

function toggleEventCompleteLocal(id) {
  const map = Store.get('completedEvents') || {};
  const nowCompleted = !map[id];
  if (nowCompleted) map[id] = true; else delete map[id];
  Store.set('completedEvents', map);
  return nowCompleted;
}

async function toggleComplete(ev) {
  const nowCompleted = toggleEventCompleteLocal(ev.id);
  state.completedMap = Store.get('completedEvents') || {};
  if (nowCompleted) playCompleteSound();
  return nowCompleted;
}

// 완료 체크 시 알림 소리 (외부 음원 파일 없이 Web Audio로 짧은 비프음 생성)
function playCompleteSound() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(880, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.12);
    g.gain.setValueAtTime(0.18, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.3);
    o.connect(g);
    g.connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.3);
    o.onended = () => ctx.close();
  } catch (e) {
    // 오디오 재생 실패는 무시 (예: 자동재생 정책)
  }
}

// ---------------- Rendering ----------------
function renderWeekHeader() {
  const el = document.getElementById('weekHeader');
  el.innerHTML = '';
  orderedWeekdays().forEach((wd, i) => {
    const div = document.createElement('div');
    div.textContent = wd;
    const jsIdx = (state.settings.startOfWeek + i) % 7;
    div.style.color = weekdayColor(jsIdx);
    el.appendChild(div);
  });
}

function updatePeriodLabel() {
  const c = state.current;
  const label = document.getElementById('periodLabel');
  if (state.view === 'month') label.textContent = `${c.getFullYear()}년 ${c.getMonth() + 1}월`;
  else if (state.view === 'week') label.textContent = `${c.getFullYear()}년 ${c.getMonth() + 1}월 ${Math.ceil(c.getDate()/7)}주`;
  else label.textContent = `${c.getFullYear()}.${pad2(c.getMonth()+1)}.${pad2(c.getDate())}`;
}

async function renderMonth(skipFetch) {
  const body = document.getElementById('calendarBody');
  body.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'month-grid';

  const year = state.current.getFullYear();
  const month = state.current.getMonth();
  const firstOfMonth = new Date(year, month, 1);
  const startOffset = (firstOfMonth.getDay() - state.settings.startOfWeek + 7) % 7;
  const gridStart = addDays(firstOfMonth, -startOffset);

  if (!skipFetch) {
    await ensureHolidays(year);
    if (gridStart.getFullYear() !== year) await ensureHolidays(gridStart.getFullYear());
    const gridEndPreview = addDays(gridStart, 41);
    if (gridEndPreview.getFullYear() !== year) await ensureHolidays(gridEndPreview.getFullYear());

    await loadEventsForRange(gridStart, addDays(gridStart, 42));
  }

  for (let i = 0; i < 42; i++) {
    const d = addDays(gridStart, i);
    const cell = document.createElement('div');
    cell.className = 'day-cell no-drag';
    const isOtherMonth = d.getMonth() !== month;
    if (isOtherMonth) cell.classList.add('other-month');

    if (isOtherMonth && state.settings.hideOtherMonthDays) {
      // 이전/다음 달 날짜 숨기기: 칸은 유지하되 내용 없이 비워둠
      cell.classList.add('empty-cell');
      grid.appendChild(cell);
      continue;
    }

    if (sameDay(d, new Date())) cell.classList.add('today');

    const holidayMap = state.holidaysByYear[d.getFullYear()] || {};
    const holidayName = holidayMap[dateKey(d)];

    const dayNum = document.createElement('div');
    dayNum.className = 'day-num';
    dayNum.textContent = d.getDate();
    dayNum.style.color = holidayName ? state.settings.holidayColor : weekdayColor(d.getDay());
    cell.appendChild(dayNum);

    if (holidayName) {
      const hEl = document.createElement('div');
      hEl.className = 'holiday-name';
      hEl.style.color = state.settings.holidayColor;
      hEl.textContent = holidayName;
      cell.appendChild(hEl);
    }

    if (state.settings.showLunar) {
      const lunarEl = document.createElement('div');
      lunarEl.className = 'lunar-label';
      lunarEl.textContent = CalendarMath.lunarLabel(d.getFullYear(), d.getMonth() + 1, d.getDate());
      cell.appendChild(lunarEl);
    }
    if (state.settings.showSolarTerms) {
      const term = CalendarMath.solarTerm(d.getFullYear(), d.getMonth() + 1, d.getDate());
      if (term) {
        const termEl = document.createElement('div');
        termEl.className = 'term-label';
        termEl.textContent = term;
        cell.appendChild(termEl);
      }
    }

    const dayEvents = sortEventsForDisplay(visibleEventsOnDay(d));
    if (dayEvents.length) {
      const row = document.createElement('div');
      row.className = 'event-dot-row';
      const maxShow = 3;
      dayEvents.slice(0, maxShow).forEach(ev => {
        const chip = document.createElement('div');
        chip.className = 'event-chip no-drag' + (isCompleted(ev) ? ' completed' : '');
        chip.style.background = eventColor(ev);
        chip.textContent = ev.title;
        row.appendChild(chip);
      });
      if (dayEvents.length > maxShow) {
        const more = document.createElement('div');
        more.className = 'event-chip no-drag';
        more.style.background = 'transparent';
        more.textContent = `+${dayEvents.length - maxShow}`;
        row.appendChild(more);
      }
      cell.appendChild(row);
    }

    onDoubleClick(cell, (e) => {
      e.stopPropagation();
      openDayPanel(d, cell);
    });
    grid.appendChild(cell);
  }
  body.appendChild(grid);

  // CSS의 "1fr" 행 6개는 이론적으로 정확히 6등분이지만, 실제 픽셀로 환산할 때
  // 소수점 반올림 때문에 행 사이에 미세한(1px 이하) 틈이 생길 수 있습니다. 평소엔
  // 안 보이지만, '오늘' 칸처럼 배경색이 진한 셀이 그 틈에 걸치면 다음 줄 배경이
  // 살짝 비쳐 보여서 마치 달력이 아래로 반복되는 것처럼 보였습니다. 실제로 그려진
  // 후 정확한 픽셀 높이를 측정해서 6등분한 값을 다시 명시적으로 지정해 이 틈을 없앱니다.
  requestAnimationFrame(() => {
    const GAP = 2; // .month-grid의 gap 값과 반드시 같아야 함
    const rowH = Math.floor((grid.clientHeight - GAP * 5) / 6);
    if (rowH > 0) grid.style.gridTemplateRows = `repeat(6, ${rowH}px)`;
  });
}

const WEEK_ROW_HEIGHT = 44; // 1시간당 픽셀 높이 (아래 CSS의 repeating-linear-gradient 44px와 반드시 같아야 함)

async function renderWeek(skipFetch) {
  const body = document.getElementById('calendarBody');
  body.innerHTML = '';
  const start = state.settings.startOfWeek || 0;
  const offset = (state.current.getDay() - start + 7) % 7;
  const weekStart = addDays(state.current, -offset);
  if (!skipFetch) {
    await ensureHolidays(weekStart.getFullYear());
    await loadEventsForRange(weekStart, addDays(weekStart, 7));
  }
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const now = new Date();
  const todayIdx = days.findIndex(d => sameDay(d, now));

  const wrap = document.createElement('div');
  wrap.className = 'week-wrap';

  // 요일/날짜 헤더 (스크롤되지 않고 고정)
  const headRow = document.createElement('div');
  headRow.className = 'week-head-row';
  headRow.appendChild(el('div', 'week-time-spacer'));
  days.forEach(d => {
    const holidayMap = state.holidaysByYear[d.getFullYear()] || {};
    const holidayName = holidayMap[dateKey(d)];
    const head = document.createElement('div');
    head.className = 'week-head-cell' + (sameDay(d, now) ? ' is-today' : '');
    head.style.color = holidayName ? state.settings.holidayColor : weekdayColor(d.getDay());
    head.innerHTML = `<div>${WEEKDAY_KO[d.getDay()]}</div><div class="week-head-date">${d.getDate()}</div>`;
    headRow.appendChild(head);
  });
  wrap.appendChild(headRow);

  // 하루 종일 일정 스트립 (시간 그리드 위, 항상 맨 위에 고정 표시)
  const allDayRow = document.createElement('div');
  allDayRow.className = 'week-allday-row';
  allDayRow.appendChild(el('div', 'week-time-spacer'));
  days.forEach(d => {
    const col = document.createElement('div');
    col.className = 'week-allday-cell';
    onDoubleClick(col, (e) => { e.stopPropagation(); openDayPanel(d, col); });
    const holiday = holidayPseudoEvent(d);
    if (holiday) {
      const hChip = document.createElement('div');
      hChip.className = 'event-chip no-drag holiday-chip';
      hChip.style.background = state.settings.holidayColor;
      hChip.textContent = holiday.title;
      col.appendChild(hChip);
    }
    sortEventsForDisplay(eventsOnDay(d))
      .filter(ev => ev.allDay && (state.settings.showCompletedEvents !== false || !isCompleted(ev)))
      .forEach(ev => {
        const chip = document.createElement('div');
        chip.className = 'event-chip no-drag' + (isCompleted(ev) ? ' completed' : '');
        chip.style.background = eventColor(ev);
        chip.textContent = ev.title;
        col.appendChild(chip);
      });
    allDayRow.appendChild(col);
  });
  wrap.appendChild(allDayRow);

  // 시간대별 그리드 (스크롤 영역)
  const scrollArea = document.createElement('div');
  scrollArea.className = 'week-scroll';
  initDragToScroll(scrollArea);
  const grid = document.createElement('div');
  grid.className = 'week-hour-grid';
  grid.style.height = `${24 * WEEK_ROW_HEIGHT}px`;

  const timeCol = document.createElement('div');
  timeCol.className = 'week-time-col';
  for (let h = 0; h < 24; h++) {
    const lbl = document.createElement('div');
    lbl.className = 'week-hour-label';
    lbl.style.height = `${WEEK_ROW_HEIGHT}px`;
    lbl.textContent = h === 0 ? '' : `${pad2(h)}:00`;
    timeCol.appendChild(lbl);
  }
  grid.appendChild(timeCol);

  const daysArea = document.createElement('div');
  daysArea.className = 'week-days-area';
  days.forEach(d => {
    const track = document.createElement('div');
    track.className = 'week-day-track no-drag' + (sameDay(d, now) ? ' is-today' : '');

    sortEventsForDisplay(eventsOnDay(d))
      .filter(ev => !ev.allDay && (state.settings.showCompletedEvents !== false || !isCompleted(ev)))
      .forEach(ev => {
        const dayStart = startOfDay(d).getTime();
        const startMin = Math.max(0, (ev.start - dayStart) / 60000);
        const endMin = Math.min(1440, (ev.end - dayStart) / 60000);
        const top = (startMin / 60) * WEEK_ROW_HEIGHT;
        const height = Math.max(16, ((endMin - startMin) / 60) * WEEK_ROW_HEIGHT - 2);
        const block = document.createElement('div');
        block.className = 'week-event-block no-drag' + (isCompleted(ev) ? ' completed' : '');
        block.style.top = `${top}px`;
        block.style.height = `${height}px`;
        block.style.background = eventColor(ev);
        const timeStr = `${new Date(ev.start).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}`;
        block.innerHTML = `<div class="week-event-title">${ev.title}</div><div class="week-event-time">${timeStr}</div>`;
        track.appendChild(block);
      });

    // 일정 블록이든 빈 영역이든, 더블클릭하면 그 날짜의 당일 패널을 엽니다.
    onDoubleClick(track, (e) => {
      e.stopPropagation();
      openDayPanel(d, track);
    });
    daysArea.appendChild(track);
  });

  // 현재 시간을 가로선으로 표시 (이번 주에 오늘이 포함된 경우만)
  if (todayIdx >= 0) {
    const nowLine = document.createElement('div');
    nowLine.className = 'week-now-line';
    const nowMin = now.getHours() * 60 + now.getMinutes();
    nowLine.style.top = `${(nowMin / 60) * WEEK_ROW_HEIGHT}px`;
    daysArea.appendChild(nowLine);
  }

  grid.appendChild(daysArea);
  scrollArea.appendChild(grid);
  wrap.appendChild(scrollArea);
  body.appendChild(wrap);

  // 현재 시간(또는 오전 8시) 근처로 자동 스크롤
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const targetMin = todayIdx >= 0 ? nowMin : 8 * 60;
  scrollArea.scrollTop = Math.max(0, (targetMin / 60) * WEEK_ROW_HEIGHT - scrollArea.clientHeight / 2);
}

function el(tag, className) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
}

// 일정 상세 목록(당일 패널, 일간 보기)에서 공용으로 쓰는 항목 UI.
// 항목에 커서를 올리면 체크 버튼이 나타나고, 누르면 완료 표시(취소선)가 토글됩니다.
function buildEventListItem(ev, onAfterToggle) {
  const item = document.createElement('div');
  item.className = 'day-event-item no-drag' + (isCompleted(ev) ? ' completed' : '') + (ev.isHoliday ? ' holiday-item' : '');
  item.style.borderLeft = `3px solid ${ev.isHoliday ? state.settings.holidayColor : eventColor(ev)}`;

  const timeStr = ev.isHoliday ? '공휴일' : (ev.allDay ? '하루 종일' : `${new Date(ev.start).toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'})} ~ ${new Date(ev.end).toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'})}`);

  const textWrap = document.createElement('div');
  textWrap.className = 'day-event-text no-drag';
  textWrap.innerHTML = `<div class="ev-title">${ev.title}</div><small>${timeStr}</small>`;
  if (!ev.isHoliday) textWrap.addEventListener('click', () => {
    if (scrollDragMoved) { scrollDragMoved = false; return; }
    openEventModal(ev);
  });

  item.appendChild(textWrap);

  if (!ev.isHoliday) {
    const checkBtn = document.createElement('button');
    checkBtn.className = 'check-btn no-drag';
    checkBtn.textContent = '✓';
    checkBtn.title = isCompleted(ev) ? '완료 취소' : '완료로 표시';
    checkBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (scrollDragMoved) { scrollDragMoved = false; return; }
      await toggleComplete(ev);
      if (onAfterToggle) onAfterToggle();
    });
    item.appendChild(checkBtn);
  }
  return item;
}

async function renderDay(skipFetch) {
  const body = document.getElementById('calendarBody');
  body.innerHTML = '';
  const d = state.current;
  if (!skipFetch) {
    await ensureHolidays(d.getFullYear());
    await loadEventsForRange(startOfDay(d), addDays(d, 1));
  }

  const wrap = document.createElement('div');
  wrap.style.padding = '8px';

  const holidayMap = state.holidaysByYear[d.getFullYear()] || {};
  const holidayName = holidayMap[dateKey(d)];
  const info = document.createElement('div');
  info.style.marginBottom = '8px';
  let html = `<div style="font-size:16px;font-weight:600;color:${holidayName ? state.settings.holidayColor : weekdayColor(d.getDay())}">${WEEKDAY_KO[d.getDay()]}요일</div>`;
  if (holidayName) html += `<div style="color:${state.settings.holidayColor};font-size:12px">${holidayName}</div>`;
  if (state.settings.showLunar) html += `<div class="lunar-label">음력 ${CalendarMath.lunarLabel(d.getFullYear(), d.getMonth()+1, d.getDate())}</div>`;
  if (state.settings.showSolarTerms) {
    const term = CalendarMath.solarTerm(d.getFullYear(), d.getMonth()+1, d.getDate());
    if (term) html += `<div class="term-label">${term}</div>`;
  }
  info.innerHTML = html;
  wrap.appendChild(info);

  eventsOnDay(d).forEach(ev => {
    const item = buildEventListItem(ev, async () => { await renderDay(true); });
    wrap.appendChild(item);
  });

  const addBtn = document.createElement('button');
  addBtn.className = 'primary full-width';
  addBtn.textContent = '＋ 일정 추가';
  addBtn.addEventListener('click', () => openEventModal(null, d));
  wrap.appendChild(addBtn);

  body.appendChild(wrap);
}

async function render(skipFetch) {
  updatePeriodLabel();
  renderWeekHeader();
  document.getElementById('weekHeader').classList.toggle('hidden', state.view !== 'month');
  if (state.view === 'month') await renderMonth(skipFetch);
  else if (state.view === 'week') await renderWeek(skipFetch);
  else await renderDay(skipFetch);
  refreshAuthBar(); // 토큰 만료 등으로 자동 로그아웃됐을 수 있으니 매번 상태를 다시 반영
}

// ---------------- Day side panel ----------------
function openDayPanel(d, anchorEl) {
  state.selectedDay = d;
  const panel = document.getElementById('dayEventsPanel');
  document.getElementById('dayEventsTitle').textContent = `${d.getFullYear()}.${pad2(d.getMonth()+1)}.${pad2(d.getDate())} (${WEEKDAY_KO[d.getDay()]})`;
  const list = document.getElementById('dayEventsList');
  list.innerHTML = '';
  const holiday = holidayPseudoEvent(d);
  const evs = eventsOnDay(d);
  if (!holiday && !evs.length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'font-size:11px;color:#888;text-align:center;padding:10px 0;';
    empty.textContent = '일정이 없습니다';
    list.appendChild(empty);
  }
  if (holiday) list.appendChild(buildEventListItem(holiday));
  evs.forEach(ev => {
    const item = buildEventListItem(ev, async () => {
      openDayPanel(d, anchorEl);
      await render(true);
    });
    list.appendChild(item);
  });
  panel.classList.remove('hidden');
  positionPanelNearAnchor(panel, anchorEl);
}

// 패널을 더블클릭한 날짜 칸 근처에 뜨도록 위치를 계산합니다.
// (기본은 오른쪽에 붙이고, 공간이 없으면 왼쪽/위아래로 조정해 #app 영역 밖으로 나가지 않게 합니다)
function positionPanelNearAnchor(panel, anchorEl) {
  const appEl = document.getElementById('app');
  if (!anchorEl || !appEl) return;
  const appRect = appEl.getBoundingClientRect();
  const anchorRect = anchorEl.getBoundingClientRect();
  const panelWidth = panel.offsetWidth || 240;
  const panelHeight = panel.offsetHeight || 200;
  const margin = 6;

  let left = anchorRect.right - appRect.left + margin;
  if (left + panelWidth > appRect.width - margin) {
    left = anchorRect.left - appRect.left - panelWidth - margin;
  }
  if (left < margin) left = margin;

  let top = anchorRect.top - appRect.top;
  if (top + panelHeight > appRect.height - margin) {
    top = appRect.height - panelHeight - margin;
  }
  if (top < margin) top = margin;

  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
  panel.style.right = 'auto';
}

document.getElementById('dayEventsClose').addEventListener('click', () => {
  document.getElementById('dayEventsPanel').classList.add('hidden');
});
document.getElementById('dayEventsAdd').addEventListener('click', () => {
  openEventModal(null, state.selectedDay || new Date());
});

// 패널이 열려있는 상태에서 패널/모달 바깥(다른 날짜 칸, 상단바 등)을 클릭하면
// ×를 누르지 않아도 자동으로 닫히게 합니다.
document.addEventListener('click', (e) => {
  const panel = document.getElementById('dayEventsPanel');
  if (panel.classList.contains('hidden')) return;
  if (panel.contains(e.target)) return;
  const modal = document.getElementById('eventModal');
  if (!modal.classList.contains('hidden') && modal.contains(e.target)) return;
  panel.classList.add('hidden');
});

// ---------------- Event modal ----------------
// 날짜/시간은 네이티브 input 대신 select 드롭다운(년/월/일, 시/분)으로 구성했습니다.
// Wallpaper Engine은 키보드도, 마우스 휠도 배경화면에 전달하지 않아서 네이티브
// date/time input의 세그먼트 조절이 아예 안 됐기 때문입니다. select는 클릭만으로
// 열고 고를 수 있어서 이 제약과 무관하게 동작합니다.
function daysInMonth(year, month) { return new Date(year, month, 0).getDate(); } // month: 1~12

function fillSelect(sel, count, startAt, formatFn) {
  sel.innerHTML = '';
  for (let i = 0; i < count; i++) {
    const value = startAt + i;
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = formatFn ? formatFn(value) : String(value);
    sel.appendChild(opt);
  }
}

function populateDateSelects(prefix, date) {
  const yearSel = document.getElementById(prefix + 'Year');
  const monthSel = document.getElementById(prefix + 'Month');
  const daySel = document.getElementById(prefix + 'Day');
  const curYear = date.getFullYear();

  fillSelect(yearSel, 8, curYear - 2, (y) => y + '년');
  yearSel.value = curYear;
  fillSelect(monthSel, 12, 1, (m) => m + '월');
  monthSel.value = date.getMonth() + 1;

  const refreshDays = (keepDay) => {
    const y = Number(yearSel.value), m = Number(monthSel.value);
    const maxDay = daysInMonth(y, m);
    const wanted = keepDay != null ? keepDay : Number(daySel.value) || 1;
    fillSelect(daySel, maxDay, 1, (d) => d + '일');
    daySel.value = Math.min(wanted, maxDay);
  };
  refreshDays(date.getDate());
  yearSel.onchange = () => refreshDays();
  monthSel.onchange = () => refreshDays();
}

function populateTimeSelects(prefix, date) {
  const hourSel = document.getElementById(prefix + 'Hour');
  const minSel = document.getElementById(prefix + 'Minute');
  fillSelect(hourSel, 24, 0, pad2);
  hourSel.value = date.getHours();
  fillSelect(minSel, 60, 0, pad2);
  minSel.value = date.getMinutes();
}

function getPickedDate(prefix) {
  const y = Number(document.getElementById(prefix + 'Year').value);
  const m = Number(document.getElementById(prefix + 'Month').value);
  const d = Number(document.getElementById(prefix + 'Day').value);
  return new Date(y, m - 1, d);
}

function getPickedDateTime(prefix) {
  const base = getPickedDate(prefix);
  base.setHours(Number(document.getElementById(prefix + 'Hour').value), Number(document.getElementById(prefix + 'Minute').value), 0, 0);
  return base;
}

// 하루 종일 체크박스 상태에 따라 시간 선택을 켜고 끕니다.
function updateTimeFieldsDisabled() {
  const allDay = document.getElementById('evAllDay').checked;
  ['evStartHour', 'evStartMinute', 'evEndHour', 'evEndMinute'].forEach(id => {
    document.getElementById(id).disabled = allDay;
  });
}
document.getElementById('evAllDay').addEventListener('change', updateTimeFieldsDisabled);

function openEventModal(ev, presetDate) {
  state.editingEvent = ev;
  document.getElementById('modalTitle').textContent = ev ? '일정 수정' : '일정 추가';
  document.getElementById('evTitle').value = ev ? ev.title : '';
  document.getElementById('evDesc').value = ev ? (ev.description || '') : '';
  document.getElementById('evAllDay').checked = ev ? ev.allDay : true;
  document.getElementById('evDeleteBtn').classList.toggle('hidden', !ev);

  const base = ev ? new Date(ev.start) : (presetDate || new Date());
  const baseEnd = ev ? new Date(ev.end) : (presetDate || new Date());
  const startTimeDefault = new Date(base); startTimeDefault.setHours(9, 0, 0, 0);
  const endTimeDefault = new Date(baseEnd); endTimeDefault.setHours(10, 0, 0, 0);

  populateDateSelects('evStart', base);
  populateDateSelects('evEnd', baseEnd);
  populateTimeSelects('evStart', ev && !ev.allDay ? base : startTimeDefault);
  populateTimeSelects('evEnd', ev && !ev.allDay ? baseEnd : endTimeDefault);
  updateTimeFieldsDisabled();

  document.getElementById('eventModal').classList.remove('hidden');
  setTimeout(() => document.getElementById('evTitle').focus(), 0);
}

function closeEventModal() {
  document.getElementById('eventModal').classList.add('hidden');
  state.editingEvent = null;
}

document.getElementById('evCancelBtn').addEventListener('click', closeEventModal);

// 키보드 입력이 안 되는 환경(Wallpaper Engine)을 위한 붙여넣기 버튼.
// 다른 프로그램(메모장 등)에서 Ctrl+C로 복사한 텍스트를 클립보드에서 읽어와 채워줍니다.
async function pasteFromClipboard(inputEl) {
  try {
    const text = await navigator.clipboard.readText();
    if (text) inputEl.value = text;
  } catch (e) {
    showMessage(
      '클립보드를 읽을 수 없습니다.\n다른 프로그램(메모장 등)에서 텍스트를 Ctrl+C로 복사한 뒤 다시 눌러주세요.\n\n(오류: ' + e.message + ')',
      '붙여넣기 실패'
    );
  }
}
document.getElementById('evTitlePaste').addEventListener('click', () => pasteFromClipboard(document.getElementById('evTitle')));
document.getElementById('evDescPaste').addEventListener('click', () => pasteFromClipboard(document.getElementById('evDesc')));

// 모달 바깥의 어두운 배경을 클릭하면(안쪽 박스가 아니라 배경 자체를 클릭했을 때만) 닫습니다.
document.getElementById('eventModal').addEventListener('click', (e) => {
  if (e.target.id === 'eventModal') closeEventModal();
});

document.getElementById('evSaveBtn').addEventListener('click', async () => {
  const title = document.getElementById('evTitle').value.trim();
  if (!title) { showMessage('제목을 입력해 주세요'); return; }
  const allDay = document.getElementById('evAllDay').checked;
  let start, end;
  if (allDay) {
    start = getPickedDate('evStart').getTime();
    end = addDays(getPickedDate('evEnd'), 1).getTime();
  } else {
    start = getPickedDateTime('evStart').getTime();
    end = getPickedDateTime('evEnd').getTime();
  }
  const payload = {
    ...(state.editingEvent || {}),
    title,
    description: document.getElementById('evDesc').value,
    allDay,
    start,
    end
  };
  const saved = state.editingEvent
    ? await GoogleCalendar.updateEvent(payload)
    : await GoogleCalendar.addEvent(payload);
  upsertLocalEvent(saved);
  closeEventModal();
  await render(true); // 방금 받은 결과만 반영, 구글에 재조회하지 않음
  if (state.selectedDay) openDayPanel(state.selectedDay);
});

document.getElementById('evDeleteBtn').addEventListener('click', () => {
  if (!state.editingEvent) return;
  showConfirm('이 일정을 삭제할까요?', async () => {
    await GoogleCalendar.deleteEvent(state.editingEvent);
    removeLocalEvent(state.editingEvent.id);
    closeEventModal();
    await render(true); // 삭제된 결과만 반영, 구글에 재조회하지 않음
    if (state.selectedDay) openDayPanel(state.selectedDay);
  });
});

// ---------------- Top bar controls ----------------
document.getElementById('btnPrev').addEventListener('click', () => {
  if (state.view === 'month') state.current = new Date(state.current.getFullYear(), state.current.getMonth() - 1, 1);
  else if (state.view === 'week') state.current = addDays(state.current, -7);
  else state.current = addDays(state.current, -1);
  render();
});
document.getElementById('btnNext').addEventListener('click', () => {
  if (state.view === 'month') state.current = new Date(state.current.getFullYear(), state.current.getMonth() + 1, 1);
  else if (state.view === 'week') state.current = addDays(state.current, 7);
  else state.current = addDays(state.current, 1);
  render();
});
document.getElementById('btnToday').addEventListener('click', () => { state.current = new Date(); render(); });
document.getElementById('btnAdd').addEventListener('click', () => openEventModal(null, state.current));

document.querySelectorAll('#viewSwitch button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#viewSwitch button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.view = btn.dataset.view;
    render();
  });
});

// ---------------- Auth (기기 흐름 - 로컬 서버 없이 로그인) ----------------
function refreshAuthBar() {
  const authed = GoogleAuth.isAuthenticated();
  document.getElementById('authStatus').textContent = authed ? '구글 캘린더 연동됨' : '구글 캘린더 미연동';
  document.getElementById('btnAuth').textContent = authed ? '연동 해제' : '연동하기';
}

function openDeviceAuthModal() {
  document.getElementById('deviceAuthText').textContent = '코드를 준비하는 중...';
  document.getElementById('deviceAuthCode').textContent = '';
  document.getElementById('deviceAuthModal').classList.remove('hidden');
}
function closeDeviceAuthModal() {
  document.getElementById('deviceAuthModal').classList.add('hidden');
}
document.getElementById('deviceAuthCancel').addEventListener('click', () => {
  GoogleAuth.cancelDeviceAuth();
  closeDeviceAuthModal();
  refreshAuthBar();
});

document.getElementById('btnAuth').addEventListener('click', async () => {
  try {
    if (GoogleAuth.isAuthenticated()) {
      GoogleAuth.signOut();
      refreshAuthBar();
      await render();
      return;
    }
    document.getElementById('btnAuth').textContent = '연동 중...';
    openDeviceAuthModal();
    await GoogleAuth.startDeviceAuth(({ userCode, verificationUrl }) => {
      document.getElementById('deviceAuthText').textContent =
        `아래 주소를 아무 브라우저에서나 열고, 표시된 코드를 입력해 승인해 주세요:\n${verificationUrl}`;
      document.getElementById('deviceAuthCode').textContent = userCode;
    });
    closeDeviceAuthModal();
    await GoogleCalendar.pushLocalOnlyEvents();
    refreshAuthBar();
    await render();
  } catch (e) {
    closeDeviceAuthModal();
    console.error(e);
    if (e.message !== '취소됨') showMessage('연동 실패: ' + e.message, '구글 계정 연동');
    refreshAuthBar();
  }
});

// ---------------- Font settings ----------------
const FONT_STACKS = {
  default: "'Segoe UI', 'Malgun Gothic', sans-serif",
  nanum: "'Nanum Gothic', 'Malgun Gothic', sans-serif",
  dotum: "'Dotum', '돋움', 'Malgun Gothic', sans-serif",
  gulim: "'Gulim', '굴림', 'Malgun Gothic', sans-serif",
  batang: "'Batang', '바탕', 'Malgun Gothic', serif",
  consolas: "'Consolas', 'D2Coding', 'Malgun Gothic', monospace"
};

function applyFontSettings(s) {
  const root = document.documentElement.style;
  root.setProperty('--app-font-family', FONT_STACKS[s.fontFamily] || FONT_STACKS.default);
  root.setProperty('--fs-scale', s.fontScale || 1);
}

// ---------------- Settings apply (구 window.api.onSettingsChanged 대체) ----------------
function applySettingsChange(s) {
  state.settings = s;
  applyFontSettings(s);
  document.getElementById('app').style.opacity = s.opacity;
  if (s.view && s.view !== state.view) {
    state.view = s.view;
    document.querySelectorAll('#viewSwitch button').forEach(b => b.classList.toggle('active', b.dataset.view === state.view));
  }
  render();
}

function updateSettingsLocal(partial) {
  const merged = Object.assign({}, Store.get('settings'), partial);
  Store.set('settings', merged);
  applySettingsChange(merged);
  return merged;
}

// ---------------- 위치 (구 OS 창 대신 직접 드래그 구현) ----------------
// 크기 조절은 오른쪽 아래를 끌어당기는 방식 대신, WE 속성 패널의
// "위젯 너비/높이" 슬라이더로만 하도록 바꿨습니다.
function initDragAndResize() {
  const app = document.getElementById('app');
  const titlebar = document.getElementById('titlebar');
  const s = Store.get('settings');

  app.style.left = (s.widgetX != null ? s.widgetX : 40) + 'px';
  app.style.top = (s.widgetY != null ? s.widgetY : 40) + 'px';
  app.style.width = (s.widgetWidth || 360) + 'px';
  app.style.height = (s.widgetHeight || 460) + 'px';

  let dragging = false, dragStartX = 0, dragStartY = 0, startLeft = 0, startTop = 0;
  titlebar.addEventListener('mousedown', (e) => {
    if (e.target.closest('.no-drag')) return; // 버튼/뷰 전환 등은 드래그로 취급하지 않음
    dragging = true;
    dragStartX = e.clientX; dragStartY = e.clientY;
    startLeft = parseFloat(app.style.left) || 0;
    startTop = parseFloat(app.style.top) || 0;
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    app.style.left = (startLeft + (e.clientX - dragStartX)) + 'px';
    app.style.top = (startTop + (e.clientY - dragStartY)) + 'px';
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    Store.set('settings.widgetX', parseFloat(app.style.left));
    Store.set('settings.widgetY', parseFloat(app.style.top));
  });
}

// ---------------- Wallpaper Engine 속성 패널 연동 (구 설정 창 대체) ----------------
// WE는 색상을 "R G B"(0~1 실수, 공백 구분)로 넘겨줍니다 -> CSS용 hex로 변환.
function weColorToHex(rgbStr) {
  const parts = rgbStr.split(' ').map(v => Math.round(parseFloat(v) * 255));
  return '#' + parts.map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('');
}

window.wallpaperPropertyListener = {
  applyUserProperties: function (properties) {
    // 진단용 로그: 콘솔에서 WE가 실제로 뭘 보내는지 그대로 확인할 수 있게 남깁니다.
    console.log('[WE] applyUserProperties 호출됨. 받은 속성 전체:', properties);
    if (properties.backgroundImage) console.log('[WE] backgroundImage 값:', JSON.stringify(properties.backgroundImage));
    if (properties.backgroundVideo) console.log('[WE] backgroundVideo 값:', JSON.stringify(properties.backgroundVideo));

    const partial = {};
    if (properties.opacity) partial.opacity = properties.opacity.value;
    if (properties.defaultView) partial.view = properties.defaultView.value;
    if (properties.startOfWeek) partial.startOfWeek = Number(properties.startOfWeek.value);
    if (properties.showLunar) partial.showLunar = !!properties.showLunar.value;
    if (properties.showSolarTerms) partial.showSolarTerms = !!properties.showSolarTerms.value;
    if (properties.hideOtherMonthDays) partial.hideOtherMonthDays = !!properties.hideOtherMonthDays.value;
    if (properties.showCompletedEvents) partial.showCompletedEvents = !!properties.showCompletedEvents.value;
    if (properties.holidayColor) partial.holidayColor = weColorToHex(properties.holidayColor.value);
    if (properties.sundayColor) partial.sundayColor = weColorToHex(properties.sundayColor.value);
    if (properties.saturdayColor) partial.saturdayColor = weColorToHex(properties.saturdayColor.value);
    if (properties.weekdayColor) partial.weekdayColor = weColorToHex(properties.weekdayColor.value);
    if (properties.fontFamily) partial.fontFamily = properties.fontFamily.value;
    if (properties.fontScale) partial.fontScale = properties.fontScale.value;
    if (properties.widgetWidth) {
      partial.widgetWidth = properties.widgetWidth.value;
      document.getElementById('app').style.width = properties.widgetWidth.value + 'px';
    }
    if (properties.widgetHeight) {
      partial.widgetHeight = properties.widgetHeight.value;
      document.getElementById('app').style.height = properties.widgetHeight.value + 'px';
    }
    if (properties.backgroundImage || properties.backgroundVideo) {
      applyBackground(
        properties.backgroundVideo ? properties.backgroundVideo.value : null,
        properties.backgroundImage ? properties.backgroundImage.value : null
      );
    }
    if (Object.keys(partial).length) updateSettingsLocal(partial);
  }
};

// WE의 file 속성 값은 이미 퍼센트 인코딩된 경로 문자열로 옵니다
// (예: "C%3A/Users/SEJIN/Pictures/%EB%B0%B0%EA%B2%BD..."처럼 콜론과 한글까지 이미 인코딩됨).
// 여기에 encodeURI()를 한 번 더 적용하면 '%' 자체가 '%25'로 다시 인코딩되면서
// %3A -> %253A 같은 이중 인코딩이 되어 파일을 못 찾게 됩니다(이번에 겪으신 문제).
// 그래서 추가 인코딩 없이 file:/// 접두사만 붙입니다.
function toFileUrl(rawPath) {
  const normalized = String(rawPath).replace(/\\/g, '/'); // 백슬래시가 섞여 있을 경우만 대비
  return 'file:///' + normalized;
}

// 배경 동영상이 지정돼 있으면 동영상을, 아니면 이미지를, 둘 다 없으면 기본 그라데이션을 보여줍니다.
// WE의 file 속성은 URL이 아니라 파일 시스템 경로를 그대로 주기 때문에, 반드시 file:/// 을
// 직접 붙여줘야 <img>/<video> src로 쓸 수 있습니다 (안 붙이면 상대경로로 오인해서 깨진
// 이미지 아이콘만 뜹니다 - 이번에 겪으신 문제가 바로 이것입니다).
function applyBackground(videoSrc, imageSrc) {
  console.log('[배경] applyBackground 호출됨. videoSrc=', videoSrc, ' imageSrc=', imageSrc);
  const img = document.getElementById('bgImage');
  const vid = document.getElementById('bgVideo');
  img.onerror = () => console.warn('[배경] 이미지 로드 실패, 시도한 URL:', img.src);
  img.onload = () => console.log('[배경] 이미지 로드 성공:', img.src);
  vid.onerror = () => console.warn('[배경] 동영상 로드 실패, 시도한 URL:', vid.src);
  vid.onloadeddata = () => console.log('[배경] 동영상 로드 성공:', vid.src);
  if (videoSrc) {
    vid.src = toFileUrl(videoSrc);
    console.log('[배경] video.src 설정:', vid.src);
    vid.style.display = 'block';
    vid.play().catch(() => {}); // 자동재생이 막히는 경우가 있어도 조용히 무시 (루프/음소거라 보통 허용됨)
    img.style.display = 'none';
  } else if (imageSrc) {
    img.src = toFileUrl(imageSrc);
    console.log('[배경] img.src 설정:', img.src);
    img.style.display = 'block';
    vid.pause();
    vid.style.display = 'none';
  } else {
    console.log('[배경] 이미지/동영상 값이 비어있어 기본 그라데이션을 유지합니다.');
    img.style.display = 'none';
    vid.pause();
    vid.style.display = 'none';
  }
}

// ---------------- Init ----------------
(function init() {
  try {
    state.settings = Store.get('settings');
    applyFontSettings(state.settings);
    document.getElementById('app').style.opacity = state.settings.opacity;
    state.completedMap = Store.get('completedEvents') || {};
    document.querySelectorAll('#viewSwitch button').forEach(b => b.classList.toggle('active', b.dataset.view === state.settings.view));
    state.view = state.settings.view || 'month';
    initDragAndResize();
    initDragToScroll(document.getElementById('calendarBody'));
    initDragToScroll(document.getElementById('dayEventsList'));
    document.querySelectorAll('.modal-box').forEach(initDragToScroll);
    refreshAuthBar();
    render();
    initTokenKeepAlive();
  } catch (e) {
    console.error('초기화 중 오류:', e);
  }
})();

// 위젯은 컴퓨터가 켜져 있는 동안 계속 떠 있으므로, 30분마다 한 번씩 미리 토큰을
// 갱신 시도합니다. 이렇게 하면 refresh_token이 실제로 계속 "사용된" 상태로
// 유지되어(구글의 6개월 미사용 만료 규칙 대비) 오래 컴퓨터를 안 켜다 켜도
// 연동이 끊겨 있을 가능성을 줄여줍니다.
function initTokenKeepAlive() {
  setInterval(() => {
    if (!GoogleAuth.isAuthenticated()) return;
    GoogleAuth.getValidAccessToken()
      .then(() => console.log('[app] 백그라운드 토큰 갱신 확인 완료'))
      .catch(e => console.warn('[app] 백그라운드 토큰 갱신 실패:', e.message));
  }, 30 * 60 * 1000); // 30분마다
}
