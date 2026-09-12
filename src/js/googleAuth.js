(function () {
  const CLIENT_ID = 'YOUR_TV_LIMITED_INPUT_CLIENT_ID.apps.googleusercontent.com'; // TODO: 발급받은 클라이언트 ID로 교체
  const CLIENT_SECRET = '';
  const SCOPES = 'https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/userinfo.email';
  const DEVICE_CODE_URL = 'https://oauth2.googleapis.com/device/code';
  const TOKEN_URL = 'https://oauth2.googleapis.com/token';

  function tokenRequestBody(fields) {
    const body = Object.assign({ client_id: CLIENT_ID }, fields);
    if (CLIENT_SECRET) body.client_secret = CLIENT_SECRET;
    return new URLSearchParams(body);
  }

  function isAuthenticated() {
    return !!Store.get('googleTokens');
  }

  function signOut() {
    Store.set('googleTokens', null);
    Store.set('googleAccountEmail', null);
  }

  async function refreshAccessToken() {
    const tokens = Store.get('googleTokens');
    if (!tokens || !tokens.refresh_token) throw new Error('연동 정보가 없습니다. 다시 로그인해 주세요.');
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenRequestBody({
        refresh_token: tokens.refresh_token,
        grant_type: 'refresh_token'
      })
    });
    if (!res.ok) throw new Error('토큰 갱신 실패 (' + res.status + ')');
    const data = await res.json();
    const merged = Object.assign({}, tokens, data, { obtained_at: Date.now() });
    Store.set('googleTokens', merged);
    return merged;
  }

  async function getValidAccessToken() {
    const tokens = Store.get('googleTokens');
    if (!tokens) throw new Error('연동되어 있지 않습니다.');
    const expiresAt = (tokens.obtained_at || 0) + (tokens.expires_in || 3600) * 1000 - 60000; // 1분 여유
    if (Date.now() < expiresAt && tokens.access_token) return tokens.access_token;
    try {
      const refreshed = await refreshAccessToken();
      return refreshed.access_token;
    } catch (e) {
      // 갱신 실패(토큰 만료/취소/네트워크 오류 등)는 "연동은 되어 있는데 계속 실패하는"
      // 깨진 상태로 남기지 않고 자동으로 로그아웃 처리합니다.
      console.warn('[GoogleAuth] 토큰 갱신 실패, 자동으로 연동을 해제합니다:', e.message);
      signOut();
      throw e;
    }
  }

  let pendingCancel = null;

  /**
   * 기기 흐름 로그인을 시작합니다.
   * onCode({ userCode, verificationUrl }) - 화면에 코드를 보여줄 때 호출됩니다.
   * 반환값: 승인 완료 시 resolve되는 Promise. cancel()로 도중에 취소할 수 있습니다.
   */
  function startDeviceAuth(onCode) {
    let cancelled = false;
    pendingCancel = () => { cancelled = true; };

    const promise = (async () => {
      const dcRes = await fetch(DEVICE_CODE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: tokenRequestBody({ scope: SCOPES })
      });
      if (!dcRes.ok) throw new Error('기기 코드 요청 실패 (' + dcRes.status + ')');
      const dc = await dcRes.json();

      onCode({
        userCode: dc.user_code,
        verificationUrl: dc.verification_url || dc.verification_uri
      });

      const intervalMs = (dc.interval || 5) * 1000;
      const deadline = Date.now() + (dc.expires_in || 1800) * 1000;

      while (true) {
        if (cancelled) throw new Error('취소됨');
        if (Date.now() > deadline) throw new Error('인증 시간이 초과되었습니다. 다시 시도해 주세요.');
        await new Promise(r => setTimeout(r, intervalMs));
        if (cancelled) throw new Error('취소됨');

        const tRes = await fetch(TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: tokenRequestBody({
            device_code: dc.device_code,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
          })
        });
        const tData = await tRes.json();
        if (tRes.ok) {
          const tokens = Object.assign({}, tData, { obtained_at: Date.now() });
          Store.set('googleTokens', tokens);
          fetchAccountEmail().catch(() => {});
          return tokens;
        }
        if (tData.error === 'authorization_pending') continue;
        if (tData.error === 'slow_down') { await new Promise(r => setTimeout(r, 5000)); continue; }
        throw new Error(tData.error_description || tData.error || '인증 실패');
      }
    })();

    return promise;
  }

  function cancelDeviceAuth() {
    if (pendingCancel) pendingCancel();
  }

  async function fetchAccountEmail() {
    const cached = Store.get('googleAccountEmail');
    if (cached) return cached;
    const token = await getValidAccessToken();
    const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: 'Bearer ' + token }
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.email) Store.set('googleAccountEmail', data.email);
    return data.email || null;
  }

  window.GoogleAuth = {
    isAuthenticated,
    signOut,
    startDeviceAuth,
    cancelDeviceAuth,
    getValidAccessToken,
    fetchAccountEmail
  };
})();
