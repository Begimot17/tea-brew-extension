/**
 * Расчёт заварки: объём + сорт → граммовка → количество и тайминги проливов.
 *
 * Главная величина — относительная крепость r: во сколько раз фактическая
 * дозировка (г/мл) отличается от эталонной для сорта (grams_per_100ml).
 * От неё зависит и длительность пролива (больше листа → короче), и их
 * количество (больше листа → чай держит дольше). Раньше количество проливов
 * было фиксированным массивом из каталога и ни от чего не зависело.
 */

export const VOLUMES = [60, 100, 120, 150, 200, 250, 300, 500]

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v))
}

/** Рекомендуемая граммовка для объёма, с точностью до 0.1 г. */
export function recommendedGrams(tea, volume) {
  return Math.round((tea.grams_per_100ml * volume) / 100 * 10) / 10
}

/** r = фактическая концентрация / эталонная. 1.0 — ровно по каталогу. */
export function strengthRatio(tea, grams, volume) {
  const ref = Math.max(1e-9, tea.grams_per_100ml || 0) / 100
  const actual = Math.max(0, grams || 0) / Math.max(1e-9, volume || 0)
  return clamp(actual / ref, 0.45, 2.2)
}

/** Множитель времени: exp = -0.85 для проливов, -0.4 для промывки. */
export function scaleFactor(tea, grams, volume, exp) {
  return clamp(Math.pow(strengthRatio(tea, grams, volume), exp), 0.45, 2.2)
}

export function scaleSec(baseSec, tea, grams, volume, exp) {
  return Math.max(3, Math.round(baseSec * scaleFactor(tea, grams, volume, exp)))
}

/**
 * Сколько проливов выдержит закладка.
 * Западная заварка (пакетик, травы) не масштабируется — там 1–2 настоя по факту.
 */
export function steepCount(tea, grams, volume) {
  const baseN = tea.steeps_sec.length
  if (tea.style === 'western') return baseN
  const r = strengthRatio(tea, grams, volume)
  return clamp(Math.round(baseN * Math.pow(r, 0.7)), 3, baseN + 4)
}

/**
 * Длительность i-го пролива из n.
 * Кривая каталога растягивается/сжимается на новое n линейной интерполяцией;
 * за пределами массива продлевается последним приростом.
 */
function curveAt(seq, pos) {
  if (!seq.length) return 10
  if (seq.length === 1) return seq[0]
  const x = pos * (seq.length - 1)
  if (x <= seq.length - 1) {
    const i = Math.floor(x)
    const f = x - i
    return seq[i] + (seq[Math.min(i + 1, seq.length - 1)] - seq[i]) * f
  }
  const growth = seq[seq.length - 1] - seq[seq.length - 2]
  return seq[seq.length - 1] + growth * (x - (seq.length - 1))
}

/** Пауза «Залей кипяток» — крупная посуда наливается дольше. */
export function pourSec(volume) {
  return clamp(Math.round(8 * Math.pow((volume || 100) / 100, 0.35)), 6, 20)
}

/** Шаги сессии: промывки + проливы. { label, sec, rinse } */
export function buildSteps(tea, grams, volume) {
  const steps = []
  const word = tea.style === 'western' ? 'Настой' : 'Пролив'
  const rinseSec = scaleSec(tea.rinse_sec, tea, grams, volume, -0.4)
  for (let i = 0; i < tea.rinses; i++)
    steps.push({ label: tea.rinses > 1 ? `Промывка ${i + 1}` : 'Промывка', sec: rinseSec, rinse: true })

  const n = steepCount(tea, grams, volume)
  const f = scaleFactor(tea, grams, volume, -0.85)
  for (let i = 0; i < n; i++) {
    const base = curveAt(tea.steeps_sec, n === 1 ? 0 : i / (n - 1))
    steps.push({ label: `${word} ${i + 1}`, sec: Math.max(3, Math.round(base * f)), rinse: false })
  }
  return steps
}

/** Общая длительность сессии с паузами на пролив, сек. */
export function totalSec(steps, volume) {
  const gap = pourSec(volume)
  return steps.reduce((s, st) => s + st.sec, 0) + gap * Math.max(0, steps.length - 1)
}

export function plural(n, forms) {
  const m10 = n % 10, m100 = n % 100
  if (m10 === 1 && m100 !== 11) return forms[0]
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return forms[1]
  return forms[2]
}

export const steepWord = (style) =>
  style === 'western' ? ['настой', 'настоя', 'настоев'] : ['пролив', 'пролива', 'проливов']

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
export function steepHint(tea, idx) {
  const n = idx - tea.rinses
  if (tea.style === 'western') {
    if (n <= 0) return 'Залей кипятком и засеки. Дошло — вынимай пакетик или процеди лист.'
    return 'Ещё один настой будет слабее — дай постоять дольше.'
  }
  if (n < 0) return 'Прогрей посуду и понюхай разогретый сухой лист.'
  if (n === 0) return 'Первый пролив: лёгкое тело, верхние ноты.'
  if (n <= 2) return 'Аромат раскрывается, тело набирает плотность.'
  if (n <= 5) return `Пик вкуса: ${(tea.desc || '').split('.')[0].toLowerCase()}.`
  return 'Вкус смягчается — ищи долгое сладкое послевкусие.'
}

/** Широкая группа сорта для фильтра. */
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
