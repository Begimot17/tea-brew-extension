/**
 * Озвучка фраз — целиком внутри расширения.
 *
 * Полагаться на системный синтез нельзя: в системе может не быть ни одного
 * русского голоса (типичная Windows приходит только с английским), и тогда
 * расширение молчит. Поэтому все фразы заранее записаны в mp3 и лежат в
 * src/assets/voices; синтез остаётся лишь запасным путём для фраз с именем
 * пользователя, которые заранее записать невозможно.
 *
 * Голос выбирается отдельно для каждого набора фраз (см. storage.voices).
 */

/** Доступные голоса. `baked` — фразы записаны и лежат в проекте. */
export const VOICES = [
  { id: 'dmitry', name: 'Дмитрий', hint: 'мужской, нейросинтез', baked: true },
  { id: 'svetlana', name: 'Светлана', hint: 'женский, нейросинтез', baked: true },
  { id: 'sunboy', name: 'Пророк Санбой', hint: 'записанный голос, только его фразы', baked: true },
  { id: 'system', name: 'Системный', hint: 'голос ОС, если он установлен', baked: false },
]

export const DEFAULT_VOICE = 'dmitry'

export function voiceName(id) {
  return VOICES.find(v => v.id === id)?.name || id
}

const manifests = new Map()

/** Манифест голоса: нормализованная фраза → имя файла. */
async function clips(voiceId) {
  if (!manifests.has(voiceId)) {
    const url = chrome.runtime.getURL(`src/data/voices-${voiceId}.json`)
    manifests.set(voiceId, fetch(url)
      .then(r => (r.ok ? r.json() : { clips: {} }))
      .then(d => d.clips || {})
      .catch(() => ({})))
  }
  return manifests.get(voiceId)
}

// Эмодзи и модификаторы в озвучке не участвуют — их нет и в ключах манифеста.
const DECOR = /[\p{Extended_Pictographic}‍️]/gu

/** Ключ клипа. Должен совпадать с normalize() в scripts/bake_voices.py. */
export function normalize(text) {
  return (text || '')
    .replace(DECOR, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?…]+$/, '')
    .trim()
    .toLowerCase()
}

/**
 * URL записанного клипа для фразы или null, если она не записана этим голосом.
 * Не записаны, например, фразы с обращением по имени: имя задаёт пользователь.
 */
export async function clipUrl(text, voiceId) {
  if (!voiceId || voiceId === 'system' || !text) return null
  const file = (await clips(voiceId))[normalize(text)]
  return file ? chrome.runtime.getURL(`src/assets/voices/${voiceId}/${file}`) : null
}
