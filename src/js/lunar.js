/**
 * 1900~2100년 사이의 음력(태음태양력) <-> 양력 변환 모듈
 * lunarInfo[i] 는 해당 연도의 (윤달 정보 + 각 달의 대/소월 정보)를 16진수로 인코딩한 값입니다.
 *  - 하위 4비트: 윤달 월 (0이면 윤달 없음)
 *  - 그 위 12비트: 1~12월(윤달 포함 최대 13개월)의 대(30일=1)/소(29일=0) 여부
 *  - 최상위 비트: 윤달의 대/소 여부
 * 이 데이터는 여러 공개 천문 계산 결과를 바탕으로 한 표준적인 음력표입니다.
 */
const lunarInfo = [
  0x04bd8,0x04ae0,0x0a570,0x054d5,0x0d260,0x0d950,0x16554,0x056a0,0x09ad0,0x055d2,
  0x04ae0,0x0a5b6,0x0a4d0,0x0d250,0x1d255,0x0b540,0x0d6a0,0x0ada2,0x095b0,0x14977,
  0x04970,0x0a4b0,0x0b4b5,0x06a50,0x06d40,0x1ab54,0x02b60,0x09570,0x052f2,0x04970,
  0x06566,0x0d4a0,0x0ea50,0x06e95,0x05ad0,0x02b60,0x186e3,0x092e0,0x1c8d7,0x0c950,
  0x0d4a0,0x1d8a6,0x0b550,0x056a0,0x1a5b4,0x025d0,0x092d0,0x0d2b2,0x0a950,0x0b557,
  0x06ca0,0x0b550,0x15355,0x04da0,0x0a5d0,0x14573,0x052d0,0x0a9a8,0x0e950,0x06aa0,
  0x0aea6,0x0ab50,0x04b60,0x0aae4,0x0a570,0x05260,0x0f263,0x0d950,0x05b57,0x056a0,
  0x096d0,0x04dd5,0x04ad0,0x0a4d0,0x0d4d4,0x0d250,0x0d558,0x0b540,0x0b5a0,0x195a6,
  0x095b0,0x049b0,0x0a974,0x0a4b0,0x0b27a,0x06a50,0x06d40,0x0af46,0x0ab60,0x09570,
  0x04af5,0x04970,0x064b0,0x074a3,0x0ea50,0x06b58,0x055c0,0x0ab60,0x096d5,0x092e0,
  0x0c960,0x0d954,0x0d4a0,0x0da50,0x07552,0x056a0,0x0abb7,0x025d0,0x092d0,0x0cab5,
  0x0a950,0x0b4a0,0x0baa4,0x0ad50,0x055d9,0x04ba0,0x0a5b0,0x15176,0x052b0,0x0a930,
  0x07954,0x06aa0,0x0ad50,0x05b52,0x04b60,0x0a6e6,0x0a4e0,0x0d260,0x0ea65,0x0d530,
  0x05aa0,0x076a3,0x096d0,0x04bd7,0x04ad0,0x0a4d0,0x1d0b6,0x0d250,0x0d520,0x0dd45,
  0x0b5a0,0x056d0,0x055b2,0x049b0,0x0a577,0x0a4b0,0x0aa50,0x1b255,0x06d20,0x0ada0,
  0x14b63,0x09370,0x049f8,0x04970,0x064b0,0x168a6,0x0ea50,0x06b20,0x1a6c4,0x0aae0,
  0x0a2e0,0x0d2e3,0x0c960,0x0d557,0x0d4a0,0x0da50,0x05d55,0x056a0,0x0a6d0,0x055d4,
  0x052d0,0x0a9b8,0x0a950,0x0b4a0,0x0b6a6,0x0ad50,0x055a0,0x0aba4,0x0a5b0,0x052b0,
  0x0b273,0x06930,0x07337,0x06aa0,0x0ad50,0x14b55,0x04b60,0x0a570,0x054e4,0x0d160,
  0x0e968,0x0d520,0x0daa0,0x16aa6,0x056d0,0x04ae0,0x0a9d4,0x0a2d0,0x0d150,0x0f252,
  0x0d520
];

const SOLAR_MONTH = [31,28,31,30,31,30,31,31,30,31,30,31];
const BASE_DATE = Date.UTC(1900, 0, 31); // 1900-01-31 = 음력 1900년 1월 1일

function lunarYearDays(y) {
  let sum = 348;
  const info = lunarInfo[y - 1900];
  for (let i = 0x8000; i > 0x8; i >>= 1) {
    sum += (info & i) ? 1 : 0;
  }
  return sum + leapDays(y);
}

function leapMonth(y) {
  return lunarInfo[y - 1900] & 0xf;
}

function leapDays(y) {
  if (leapMonth(y)) {
    return (lunarInfo[y - 1900] & 0x10000) ? 30 : 29;
  }
  return 0;
}

function monthDays(y, m) {
  return (lunarInfo[y - 1900] & (0x10000 >> m)) ? 30 : 29;
}

/** 양력 Date -> 음력 정보 {year, month, day, isLeap} */
function solarToLunar(date) {
  const utcDate = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  let offset = Math.round((utcDate - BASE_DATE) / 86400000);

  let lunarYear = 1900;
  let daysOfYear = 0;
  for (; lunarYear < 2101 && offset > 0; lunarYear++) {
    daysOfYear = lunarYearDays(lunarYear);
    offset -= daysOfYear;
  }
  if (offset < 0) {
    offset += daysOfYear;
    lunarYear--;
  }

  const leap = leapMonth(lunarYear);
  let isLeap = false;
  let lunarMonth = 1;
  let daysOfMonth = 0;
  for (; lunarMonth < 13 && offset > 0; lunarMonth++) {
    if (leap > 0 && lunarMonth === (leap + 1) && !isLeap) {
      lunarMonth--;
      isLeap = true;
      daysOfMonth = leapDays(lunarYear);
    } else {
      daysOfMonth = monthDays(lunarYear, lunarMonth);
    }
    offset -= daysOfMonth;
    if (isLeap && lunarMonth === (leap + 1)) isLeap = false;
  }
  if (offset === 0 && leap > 0 && lunarMonth === leap + 1) {
    if (isLeap) {
      isLeap = false;
    } else {
      isLeap = true;
      lunarMonth--;
    }
  }
  if (offset < 0) {
    offset += daysOfMonth;
    lunarMonth--;
  }
  const lunarDay = offset + 1;

  return { year: lunarYear, month: lunarMonth, day: lunarDay, isLeap };
}

const GAN = ['갑','을','병','정','무','기','경','신','임','계'];
const ZHI = ['자','축','인','묘','진','사','오','미','신','유','술','해'];
const ZODIAC = ['쥐','소','호랑이','토끼','용','뱀','말','양','원숭이','닭','개','돼지'];

function ganziYear(y) {
  const gan = GAN[(y - 4) % 10];
  const zhi = ZHI[(y - 4) % 12];
  return gan + zhi;
}

function zodiacOf(y) {
  return ZODIAC[(y - 4) % 12];
}

const LUNAR_MONTH_NAMES = ['','정월','2월','3월','4월','5월','6월','7월','8월','9월','10월','동짓달','섣달'];
const LUNAR_DAY_NAMES = ['','초하루','초이틀','초사흘','초나흘','초닷새','초엿새','초이레','초여드레','초아흐레','초열흘',
  '십일','십이','십삼','십사','십오','십육','십칠','십팔','십구','스무날',
  '스물하루','스물이틀','스물사흘','스물나흘','스물닷새','스물엿새','스물이레','스물여드레','스물아흐레','서른날'];

function formatLunar(lunar) {
  const leapStr = lunar.isLeap ? '윤' : '';
  return `${leapStr}${lunar.month}.${String(lunar.day).padStart(2,'0')}`;
}

window.LunarCalendar = { solarToLunar, ganziYear, zodiacOf, formatLunar, LUNAR_MONTH_NAMES, LUNAR_DAY_NAMES };
