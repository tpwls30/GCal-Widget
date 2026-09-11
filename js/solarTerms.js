/**
 * 24절기 계산 - 태양의 겉보기 황경(apparent ecliptic longitude)이
 * 15도 배수가 되는 순간을 뉴턴법으로 근사(Meeus 저정밀 공식 기반, 오차 수 분 이내)
 */

function toJD(y, m, d, hour = 12) {
  if (m <= 2) { y -= 1; m += 12; }
  const A = Math.floor(y / 100);
  const B = 2 - A + Math.floor(A / 4);
  return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + d + hour / 24 + B - 1524.5;
}

function fromJD(jd) {
  jd += 0.5;
  const Z = Math.floor(jd);
  const F = jd - Z;
  let A = Z;
  if (Z >= 2299161) {
    const alpha = Math.floor((Z - 1867216.25) / 36524.25);
    A = Z + 1 + alpha - Math.floor(alpha / 4);
  }
  const B = A + 1524;
  const C = Math.floor((B - 122.1) / 365.25);
  const D = Math.floor(365.25 * C);
  const E = Math.floor((B - D) / 30.6001);
  const day = B - D - Math.floor(30.6001 * E) + F;
  const month = E < 14 ? E - 1 : E - 13;
  const year = month > 2 ? C - 4716 : C - 4715;
  const dayInt = Math.floor(day);
  const hourFrac = (day - dayInt) * 24;
  return { year, month, day: dayInt, hour: hourFrac };
}

function solarLongitude(jd) {
  const T = (jd - 2451545.0) / 36525;
  const L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T;
  const M = 357.52911 + 35999.05029 * T - 0.0001537 * T * T;
  const Mrad = (M * Math.PI) / 180;
  const C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(Mrad) +
            (0.019993 - 0.000101 * T) * Math.sin(2 * Mrad) +
            0.000289 * Math.sin(3 * Mrad);
  const trueLong = L0 + C;
  const omega = 125.04 - 1934.136 * T;
  const apparent = trueLong - 0.00569 - 0.00478 * Math.sin((omega * Math.PI) / 180);
  return ((apparent % 360) + 360) % 360;
}

// 각 절기: 이름, 목표 황경(도), 해당 연도 내 대략적인 초기 추정 [month, day]
const TERMS = [
  { name: '춘분', deg: 0,   guess: [3, 20] },
  { name: '청명', deg: 15,  guess: [4, 5] },
  { name: '곡우', deg: 30,  guess: [4, 20] },
  { name: '입하', deg: 45,  guess: [5, 5] },
  { name: '소만', deg: 60,  guess: [5, 21] },
  { name: '망종', deg: 75,  guess: [6, 6] },
  { name: '하지', deg: 90,  guess: [6, 21] },
  { name: '소서', deg: 105, guess: [7, 7] },
  { name: '대서', deg: 120, guess: [7, 23] },
  { name: '입추', deg: 135, guess: [8, 8] },
  { name: '처서', deg: 150, guess: [8, 23] },
  { name: '백로', deg: 165, guess: [9, 8] },
  { name: '추분', deg: 180, guess: [9, 23] },
  { name: '한로', deg: 195, guess: [10, 8] },
  { name: '상강', deg: 210, guess: [10, 23] },
  { name: '입동', deg: 225, guess: [11, 7] },
  { name: '소설', deg: 240, guess: [11, 22] },
  { name: '대설', deg: 255, guess: [12, 7] },
  { name: '동지', deg: 270, guess: [12, 22] },
  { name: '소한', deg: 285, guess: [1, 6] },
  { name: '대한', deg: 300, guess: [1, 20] },
  { name: '입춘', deg: 315, guess: [2, 4] },
  { name: '우수', deg: 330, guess: [2, 19] },
  { name: '경칩', deg: 345, guess: [3, 6] }
];

function findTermDate(year, term) {
  let jd = toJD(year, term.guess[0], term.guess[1]);
  for (let i = 0; i < 6; i++) {
    const lon = solarLongitude(jd);
    let diff = term.deg - lon;
    if (diff > 180) diff -= 360;
    if (diff < -180) diff += 360;
    jd += diff / 0.9856; // 태양은 하루 평균 약 0.9856도 이동
  }
  const d = fromJD(jd);
  return { month: d.month, day: d.day };
}

/** 특정 연도의 24절기 목록을 [{name, month, day}] 형태로 반환 (캐시됨) */
const cache = {};
function getSolarTermsOfYear(year) {
  if (cache[year]) return cache[year];
  const list = TERMS.map(t => {
    const { month, day } = findTermDate(year, t);
    return { name: t.name, month, day };
  });
  cache[year] = list;
  return list;
}

/** 특정 날짜(YYYY-MM-DD)에 해당하는 절기 이름, 없으면 null */
function getSolarTermForDate(year, month, day) {
  const list = getSolarTermsOfYear(year);
  const hit = list.find(t => t.month === month && t.day === day);
  return hit ? hit.name : null;
}

window.SolarTerms = { getSolarTermsOfYear, getSolarTermForDate };
