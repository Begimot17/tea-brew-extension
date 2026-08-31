/**
 * Расчёт заварки: объём посуды + сорт + навеска → режим, тайминги, число проливов.
 *
 * Главное, что определяет заварку, — соотношение воды к листу (мл на грамм).
 * По нему чай заваривают одним из двух принципиально разных способов, и
 * растягивать параметры одного на другой бессмысленно:
 *
 *   Гунфу (гайвань, исин): ~1:15 — 1:20 (5–7 г на 100 мл). Много листа, мало
 *   воды, проливы по 8–60 секунд, 8–15 проливов. Каталожные `steeps_sec`
 *   описывают именно этот режим.
 *
 *   Западная заварка (чайник, кружка): ~1:80 — 1:125 (2–3 г на 250 мл).
 *   Мало листа, много воды, настой 2–5 минут, 1–3 настоя.
 *
 * 8 г пуэра на 500 мл — это 1:62, то есть западная заварка: один-два настоя по
 * несколько минут, а не «слабое гунфу» из десятка десятиминутных проливов.
 *
 * Источники параметров: Yunnan Sourcing (гунфу по типам чая), white2tea
 * (пуэр), AO Tea / Steep Atlas (гунфу против западной), Red Rock Tea House
 * (улун, число настоев).
 */

export const VOLUMES = [60, 100, 120, 150, 200, 250, 300, 500]

/**
 * Граница режимов, мл воды на грамм листа. Гунфу — это 1:15…1:25 плюс запас;
 * всё, что жиже, ведёт себя как заварка в чайнике, а не как слабое гунфу.
 */
export const MODE_THRESHOLD = 28

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v))
}

/** Рекомендуемая навеска для объёма, с точностью до 0.1 г. */
export function recommendedGrams(tea, volume) {
  return Math.round((tea.grams_per_100ml * volume) / 100 * 10) / 10
}

/** Мл воды на грамм листа — то самое «1:20», которым меряют заварку. */
export function waterRatio(grams, volume) {
  return Math.max(1e-9, volume || 0) / Math.max(1e-9, grams || 0)
}

/**
 * r = фактическая концентрация / эталонная для сорта. 1.0 — ровно по каталогу.
 * Осмысленно внутри режима: в гунфу это «плотнее/жиже обычного».
 */
export function strengthRatio(tea, grams, volume) {
  const ref = Math.max(1e-9, tea.grams_per_100ml || 0) / 100
  const actual = Math.max(0, grams || 0) / Math.max(1e-9, volume || 0)
  return actual / ref
}

/**
 * Каким способом заваривается такая закладка.
 * Сорта с `style: 'western'` (пакетик, травы) гунфу не заваривают в принципе.
 */
export function brewMode(tea, grams, volume) {
  if (tea.style === 'western') return 'western'
  return waterRatio(grams, volume) <= MODE_THRESHOLD ? 'gongfu' : 'western'
}

// ── Гунфу ────────────────────────────────────────────────────────────────────

/**
 * Кривая каталога, растянутая на новое число проливов.
 * За пределами массива продлевается последним приростом.
 */
function curveAt(seq, pos) {
  if (!seq.length) return 10
  if (seq.length === 1) return seq[0]
  const x = pos * (seq.length - 1)
  if (x <= seq.length - 1) {
    const i = Math.floor(x)
    return seq[i] + (seq[Math.min(i + 1, seq.length - 1)] - seq[i]) * (x - i)
  }
  const growth = seq[seq.length - 1] - seq[seq.length - 2]
  return seq[seq.length - 1] + growth * (x - (seq.length - 1))
}

/**
 * Сколько проливов держит гунфу-закладка.
 * Плотнее навеска — больше проливов, но не пропорционально: лист отдаёт
 * ограниченный запас, а не удваивает его вместе с массой.
 */
function gongfuSteeps(tea, r) {
  const baseN = tea.steeps_sec.length
  return clamp(Math.round(baseN * Math.pow(r, 0.6)), 4, baseN + 3)
}

function gongfuSteps(tea, grams, volume) {
  const steps = []
  const r = strengthRatio(tea, grams, volume)
  const rinseF = clamp(Math.pow(r, -0.4), 0.6, 1.8)
  const rinseSec = Math.max(3, Math.round(tea.rinse_sec * rinseF))
  for (let i = 0; i < tea.rinses; i++)
    steps.push({ label: tea.rinses > 1 ? `Промывка ${i + 1}` : 'Промывка', sec: rinseSec, rinse: true })

  const n = gongfuSteeps(tea, r)
  // Меньше листа — держим дольше, но в разумных пределах: пролив в гайвани
  // остаётся проливом, а не пятиминутным настоем.
  const f = clamp(Math.pow(r, -0.85), 0.5, 2.5)
  for (let i = 0; i < n; i++) {
    const base = curveAt(tea.steeps_sec, n === 1 ? 0 : i / (n - 1))
    // Потолок в 4 минуты: пролив в гайвани остаётся проливом. Если хочется
    // дольше — это уже другой режим, и он включится сам по соотношению.
    steps.push({ label: `Пролив ${i + 1}`, sec: clamp(Math.round(base * f), 3, 240), rinse: false })
  }
  return steps
}

// ── Западная заварка ─────────────────────────────────────────────────────────

/** Первый настой при стандартных 1:100, сек. Разные сорта — разное время. */
const WESTERN_BASE = {
  'Пуэр': 240, 'Тёмный': 240,
  'Улун': 180, 'Белый': 180,
  'Красный': 210,
  'Зелёный': 150,
  'Другое': 180,
}

/** Сколько раз сорт переживает западный перезалив при стандартной дозе. */
const WESTERN_INFUSIONS = {
  'Пуэр': 3, 'Тёмный': 3, 'Улун': 3,
  'Красный': 2, 'Белый': 2, 'Зелёный': 2,
  'Другое': 2,
}

function westernSteps(tea, grams, volume) {
  // Сорта, которые только так и заваривают, описаны в каталоге напрямую.
  if (tea.style === 'western') {
    const steps = []
    tea.steeps_sec.forEach((s, i) => steps.push({ label: `Настой ${i + 1}`, sec: s, rinse: false }))
    return steps
  }

  const group = teaGroup(tea)
  const ratio = waterRatio(grams, volume)
  const base = WESTERN_BASE[group] ?? 180

  // Меньше листа на ту же воду — дольше настой, но с потолком: после ~8 минут
  // растёт горечь, а не крепость.
  const first = clamp(Math.round(base * Math.pow(ratio / 100, 0.8)), 60, 480)

  let n = WESTERN_INFUSIONS[group] ?? 2
  if (ratio > 120) n -= 1          // листа совсем мало — второй настой уже пустой
  else if (ratio < 50) n += 1      // листа много для чайника — переживёт лишний
  n = clamp(n, 1, 4)

  const steps = []
  // Пуэр и хэйча промывают и в чайнике — прессовка должна раскрыться.
  if (tea.rinses > 0 && (group === 'Пуэр' || group === 'Тёмный'))
    steps.push({ label: 'Промывка', sec: 10, rinse: true })

  let sec = first
  for (let i = 0; i < n; i++) {
    steps.push({ label: `Настой ${i + 1}`, sec: Math.round(sec), rinse: false })
    sec = Math.min(sec * 1.4, 360)   // каждый следующий настой дольше, но не бесконечно
  }
  return steps
}

// ── Общий вход ───────────────────────────────────────────────────────────────

/** Шаги сессии: промывки + проливы/настои. { label, sec, rinse } */
export function buildSteps(tea, grams, volume) {
  return brewMode(tea, grams, volume) === 'gongfu'
    ? gongfuSteps(tea, grams, volume)
    : westernSteps(tea, grams, volume)
}

/** Сколько проливов (настоев) без учёта промывок. */
export function steepCount(tea, grams, volume) {
  return buildSteps(tea, grams, volume).filter(s => !s.rinse).length
}

/** Чистое время заварки, сек — сумма шагов, без пауз на разлив. */
export function totalSec(steps) {
  return steps.reduce((s, st) => s + st.sec, 0)
}

/** Как назвать шаги и саму заварку в интерфейсе. */
export function modeInfo(tea, grams, volume) {
  const mode = brewMode(tea, grams, volume)
  const ratio = Math.round(waterRatio(grams, volume))
  if (mode === 'gongfu') {
    const r = strengthRatio(tea, grams, volume)
    const hint = r >= 1.3 ? 'плотно — снимай быстро'
      : r <= 0.75 ? 'жиже обычного — держи дольше'
        : 'по эталону сорта'
    return { mode, ratio, name: 'Гунфу', hint, word: ['пролив', 'пролива', 'проливов'] }
  }
  return {
    mode, ratio, name: tea.style === 'western' ? 'Заварка' : 'Западная заварка',
    hint: 'много воды на лист — настой длинный',
    word: ['настой', 'настоя', 'настоев'],
  }
}

// ── Прочее для интерфейса ────────────────────────────────────────────────────

export function plural(n, forms) {
  const m10 = n % 10, m100 = n % 100
  if (m10 === 1 && m100 !== 11) return forms[0]
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return forms[1]
  return forms[2]
}

export const fmt = (s) =>
  `${Math.floor(s / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, '0')}`

/** Время суток — для подсказки «уместен ли чай сейчас». */
export function slotNow(now = new Date()) {
  const h = now.getHours()
  if (h >= 5 && h < 11) return 'morning'
  if (h >= 11 && h < 17) return 'day'
  if (h >= 17 && h < 22) return 'evening'
  return 'night'
}

const SLOT_ORDER = ['morning', 'day', 'evening', 'night']
const SLOT_LABEL = { morning: 'утром', day: 'днём', evening: 'вечером', night: 'ночью' }

/** null, если у сорта нет рекомендаций по времени. */
export function timeFit(tea, slot = slotNow()) {
  const times = tea.times || []
  if (!times.length) return null
  const rec = times.map(s => SLOT_LABEL[s]).join(', ')
  if (times.includes(slot)) return { level: 'good', emoji: '✅', text: `В самый раз — этот чай для «${SLOT_LABEL[slot]}»` }
  const now = SLOT_ORDER.indexOf(slot)
  const idxs = times.map(s => SLOT_ORDER.indexOf(s))
  if (now > Math.max(...idxs)) return { level: 'late', emoji: '🌙', text: `Поздновато — лучше ${rec}, может помешать сну` }
  if (now < Math.min(...idxs)) return { level: 'early', emoji: '⏳', text: `Рановато — раскрывается ${rec}` }
  return { level: 'soft', emoji: '☕', text: `Хорош ${rec}, сейчас тоже подойдёт` }
}

/** Подсказка «на что обратить внимание» по фазе. */
export function steepHint(tea, idx, mode = 'gongfu') {
  const rinses = tea.rinses || 0
  const n = idx - rinses
  if (mode === 'western') {
    if (n < 0) return 'Ополосни лист кипятком и слей — прессовка раскроется.'
    if (n === 0) return 'Залей и не тревожь. Дошло — сразу отдели лист, иначе перегорчит.'
    return 'Перезалив: настой будет слабее, поэтому держи заметно дольше.'
  }
  if (n < 0) return 'Прогрей посуду и понюхай разогретый сухой лист.'
  if (n === 0) return 'Первый пролив: лёгкое тело, верхние ноты.'
  if (n <= 2) return 'Аромат раскрывается, тело набирает плотность.'
  if (n <= 5) return `Пик вкуса: ${(tea.desc || '').split('.')[0].toLowerCase()}.`
  return 'Вкус смягчается — ищи долгое сладкое послевкусие.'
}

/** Широкая группа сорта — она же ключ к западным параметрам. */
export function teaGroup(tea) {
  const c = (tea.category || '').toLowerCase()
  if (c.includes('пуэр')) return 'Пуэр'
  if (c.includes('улун')) return 'Улун'
  if (c.includes('красный')) return 'Красный'
  if (c.includes('тёмный')) return 'Тёмный'
  if (tea.style === 'western') return 'Бытовой'
  if (c.includes('зелёный')) return 'Зелёный'
  if (c.includes('белый')) return 'Белый'
  return 'Другое'
}
