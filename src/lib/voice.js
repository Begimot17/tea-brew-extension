/**
 * Озвучка фраз.
 *
 * У Пророка Санбоя фразы записаны голосом (клипы запечены f5tts+rvc, лежат в
 * src/assets/voices/sunboy). Всё остальное — и классические чайные фразы, и
 * фразы с обращением по имени, которые запечь нельзя, — читает системный
 * синтез речи.
 */

import { PACK_SUNBOY } from './phrases.js'

let manifest = null

async function clips() {
  if (!manifest) {
    manifest = await fetch(chrome.runtime.getURL('src/data/sunboy-clips.json'))
      .then(r => r.json())
      .then(d => d.clips || {})
      .catch(() => ({}))
  }
  return manifest
}

// Эмодзи и модификаторы в озвучке не участвуют — их нет и в ключах манифеста.
const DECOR = /[\p{Extended_Pictographic}‍️]/gu

/** Ключ клипа. Должен совпадать с нормализацией в печи (bake_voice_lines.py). */
export function normalize(text) {
  return (text || '')
    .replace(DECOR, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?…]+$/, '')
    .trim()
    .toLowerCase()
}

/** URL записанного клипа для фразы или null, если она не запечена. */
export async function clipUrl(text, pack) {
  if (pack !== PACK_SUNBOY || !text) return null
  const file = (await clips())[normalize(text)]
  return file ? chrome.runtime.getURL(`src/assets/voices/sunboy/${file}`) : null
}
