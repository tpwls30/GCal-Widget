(function () {
  const HOLIDAY_CALENDAR_ID_FALLBACK = 'ko.south_korea#holiday@group.v.calendar.google.com';
  const API_BASE = 'https://www.googleapis.com/calendar/v3';

  async function authedFetch(url, options) {
    options = options || {};
    const token = await GoogleAuth.getValidAccessToken();
    const headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers, {
      Authorization: 'Bearer ' + token
    });
    const res = await fetch(url, Object.assign({}, options, { headers }));
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error('Google API 오류 (' + res.status + '): ' + text);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  async function listEvents(timeMin, timeMax) {
    const settings = Store.get('settings');
    if (!GoogleAuth.isAuthenticated()) {
      const localEvents = Store.get('localEvents') || [];
      return localEvents.filter(e => e.start < timeMax && e.end > timeMin);
    }
    try {
      const calendarId = encodeURIComponent(settings.calendarId || 'primary');
      const params = new URLSearchParams({
        timeMin: new Date(timeMin).toISOString(),
        timeMax: new Date(timeMax).toISOString(),
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: '2500'
      });
      const data = await authedFetch(API_BASE + '/calendars/' + calendarId + '/events?' + params.toString());
      return (data.items || []).map(googleEventToLocal);
    } catch (e) {
      console.warn('[GoogleCalendar] listEvents 실패, 로컬 일정만 표시합니다:', e.message);
      const localEvents = Store.get('localEvents') || [];
      return localEvents.filter(e => e.start < timeMax && e.end > timeMin);
    }
  }

  async function resolveHolidayCalendarId() {
    const cached = Store.get('holidayCalendarId');
    if (cached) return cached;
    try {
      const data = await authedFetch(API_BASE + '/users/me/calendarList?maxResults=250');
      const items = data.items || [];
      let match = items.find(c => c.id && c.id.startsWith('ko.south_korea#holiday'));
      if (!match) match = items.find(c => c.summary && /대한민국|south korea/i.test(c.summary) && /휴일|holiday/i.test(c.summary));
      const id = (match && match.id) || HOLIDAY_CALENDAR_ID_FALLBACK;
      Store.set('holidayCalendarId', id);
      return id;
    } catch (e) {
      return HOLIDAY_CALENDAR_ID_FALLBACK;
    }
  }

  async function listHolidays(year) {
    const cacheAll = Store.get('holidayCache') || {};
    if (cacheAll[year] && cacheAll[year].length) return cacheAll[year];

    let holidays = [];
    try {
      const calendarId = await resolveHolidayCalendarId();
      const params = new URLSearchParams({
        timeMin: new Date(year + '-01-01').toISOString(),
        timeMax: new Date((Number(year) + 1) + '-01-01').toISOString(),
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: '100'
      });
      const data = await authedFetch(API_BASE + '/calendars/' + encodeURIComponent(calendarId) + '/events?' + params.toString());
      holidays = (data.items || []).map(e => ({
        date: e.start.date || (e.start.dateTime || '').slice(0, 10),
        name: e.summary
      }));
    } catch (e) {
      holidays = [];
    }

    cacheAll[year] = holidays;
    Store.set('holidayCache', cacheAll);
    return holidays;
  }

  function googleEventToLocal(ev) {
    const allDay = !!ev.start.date;
    return {
      id: ev.id,
      title: ev.summary || '(제목 없음)',
      start: allDay ? new Date(ev.start.date + 'T00:00:00').getTime() : new Date(ev.start.dateTime).getTime(),
      end: allDay ? new Date(ev.end.date + 'T00:00:00').getTime() : new Date(ev.end.dateTime).getTime(),
      allDay: allDay,
      description: ev.description || '',
      color: ev.colorId || null,
      synced: true
    };
  }

  function toLocalDateString(ts) {
    const d = new Date(ts);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  function localEventToGoogle(ev) {
    if (ev.allDay) {
      return {
        summary: ev.title,
        description: ev.description || '',
        start: { date: toLocalDateString(ev.start) },
        end: { date: toLocalDateString(ev.end) }
      };
    }
    return {
      summary: ev.title,
      description: ev.description || '',
      start: { dateTime: new Date(ev.start).toISOString() },
      end: { dateTime: new Date(ev.end).toISOString() }
    };
  }

  async function addEvent(ev) {
    if (GoogleAuth.isAuthenticated()) {
      const settings = Store.get('settings');
      const data = await authedFetch(
        API_BASE + '/calendars/' + encodeURIComponent(settings.calendarId || 'primary') + '/events',
        { method: 'POST', body: JSON.stringify(localEventToGoogle(ev)) }
      );
      return googleEventToLocal(data);
    }
    const localEvents = Store.get('localEvents') || [];
    const newEv = Object.assign({}, ev, { id: 'local-' + Date.now(), synced: false });
    localEvents.push(newEv);
    Store.set('localEvents', localEvents);
    return newEv;
  }

  async function updateEvent(ev) {
    if (GoogleAuth.isAuthenticated() && ev.synced) {
      const settings = Store.get('settings');
      const data = await authedFetch(
        API_BASE + '/calendars/' + encodeURIComponent(settings.calendarId || 'primary') + '/events/' + encodeURIComponent(ev.id),
        { method: 'PUT', body: JSON.stringify(localEventToGoogle(ev)) }
      );
      return googleEventToLocal(data);
    }
    const localEvents = Store.get('localEvents') || [];
    const idx = localEvents.findIndex(e => e.id === ev.id);
    if (idx >= 0) { localEvents[idx] = ev; Store.set('localEvents', localEvents); }
    return ev;
  }

  async function deleteEvent(ev) {
    if (GoogleAuth.isAuthenticated() && ev.synced) {
      const settings = Store.get('settings');
      await authedFetch(
        API_BASE + '/calendars/' + encodeURIComponent(settings.calendarId || 'primary') + '/events/' + encodeURIComponent(ev.id),
        { method: 'DELETE' }
      );
      return;
    }
    const localEvents = (Store.get('localEvents') || []).filter(e => e.id !== ev.id);
    Store.set('localEvents', localEvents);
  }

  async function pushLocalOnlyEvents() {
    if (!GoogleAuth.isAuthenticated()) return;
    const localEvents = Store.get('localEvents') || [];
    const remaining = [];
    for (const ev of localEvents) {
      if (ev.synced) continue;
      try { await addEvent(ev); } catch (e) { remaining.push(ev); }
    }
    Store.set('localEvents', remaining);
  }

  window.GoogleCalendar = { listEvents, listHolidays, addEvent, updateEvent, deleteEvent, pushLocalOnlyEvents };
})();
