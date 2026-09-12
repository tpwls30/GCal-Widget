// 구글 로그인 - 기기 흐름(Device Authorization Grant)
//
// 기존 Electron 버전은 localhost:42813에 임시 HTTP 서버를 띄워서 OAuth 리다이렉트를
// 받는 방식이었는데, Wallpaper Engine 웹 배경화면 안에서는 로컬 서버를 띄울 수 없습니다.
// 그래서 리다이렉트가 필요 없는 "기기 흐름"으로 바꿨습니다: 사용자에게 코드를 보여주고,
// 사용자가 아무 브라우저에서나 그 코드를 입력해 승인하면, 우리는 뒤에서 주기적으로
// 승인이 됐는지 물어봅니다(polling).
//
// ⚠️ 준비물: Google Cloud Console에서 이 프로젝트에 OAuth 클라이언트를 하나 더 만들어야 합니다.
//    "사용자 인증 정보 만들기" -> "OAuth 클라이언트 ID" -> 애플리케이션 유형: "TV 및 제한된 입력 기기".
//    이 유형은 클라이언트 시크릿이 필요 없어서(공개 배포되는 위젯 파일에 비밀 값을 넣지 않아도 됨),
//    아래 CLIENT_ID 자리에 발급받은 클라이언트 ID만 넣으면 됩니다.
//
// ⚠️ 주의: Wallpaper Engine 웹 배경화면 환경에서 외부 API로의 fetch()가 CORS 때문에
//    막힌다는 보고가 있습니다. 이 부분은 실제 Wallpaper Engine에서 직접 테스트가 필요합니다.
//    막힌다면 이 파일의 fetch 호출들이 전부 실패하며, 그 경우에도 로컬 전용 캘린더
//    기능(구글 미연동 상태와 동일)은 정상적으로 계속 동작합니다.
(function () {
  const CLIENT_ID = 'YOUR_TV_LIMITED_INPUT_CLIENT_ID.apps.googleusercontent.com'; // TODO: 발급받은 클라이언트 ID로 교체
  // "TV 및 제한된 입력 기기" 유형으로 만들었다면 시크릿이 필요 없어 비워두면 됩니다.
  // 만약 기존에 쓰던 "데스크톱 앱" 유형 클라이언트를 그대로 쓰고 있다면(Missing required
  // parameter: client_secret 오류가 난다면 이 경우입니다), 여기에 그 클라이언트의 시크릿을
  // 넣어주세요. 값이 있으면 요청에 자동으로 포함되고, 비어있으면 아예 안 보냅니다.
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
      // 깨진 상태로 남기지 않고 자동으로 로그아웃 처리합니다. 이렇게 하면 다음 조회부터
      // 바로 로컬 전용 모드로 정상 동작해서, "가끔 캘린더가 아예 안 뜨던" 문제(수동으로
      // 로그아웃 후 재연동해야만 고쳐지던 것)가 자동으로 해결됩니다.
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
