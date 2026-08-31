/** Обёртки над chrome.storage.local: настройки, сессия, избранное. */

import { PACK_CLASSIC, PACK_NEUTRAL, PACK_SUNBOY } from './phrases.js'

export const DEFAULT_SETTINGS = {
  pack: PACK_CLASSIC,      // classic | neutral | sunboy
  name: '',                // подстановка {name}; пусто — фразы без имени
  sound: true,             // гонг в конце шага
  ticks: true,             // тики на последних 3 секундах
  volumeLevel: 0.6,        // громкость 0..1
  notifications: true,     // системные уведомления
  speech: true,            // проговаривать фразу голосом
  // Голос выбирается отдельно для каждого набора фраз: у Пророка есть
  // собственный записанный голос, а классику приятнее слушать нейросинтезом.
  voices: { [PACK_CLASSIC]: 'dmitry', [PACK_NEUTRAL]: 'svetlana', [PACK_SUNBOY]: 'sunboy' },
  speechVolume: 0.9,       // громкость озвучки 0..1
  speechRate: 1,           // скорость речи синтеза
  defaultVolume: 100,      // объём посуды по умолчанию, мл
}

const SETTINGS_KEY = 'settings'
const SESSION_KEY = 'session'
const FAVORITES_KEY = 'favorites'
const GEAR_KEY = 'gear'   // последняя посуда/навеска по сортам

export async function getSettings() {
  const raw = await chrome.storage.local.get(SETTINGS_KEY)
  const saved = raw[SETTINGS_KEY] || {}
  // voices — вложенный объект, его нужно слить отдельно, иначе сохранение
  // одного пака стёрло бы выбор для остальных.
  return { ...DEFAULT_SETTINGS, ...saved, voices: { ...DEFAULT_SETTINGS.voices, ...(saved.voices || {}) } }
}

/** Голос, которым озвучивается активный набор фраз. */
export function voiceFor(settings) {
  return settings.voices?.[settings.pack] || 'dmitry'
}

export async function setSettings(patch) {
  const next = { ...(await getSettings()), ...patch }
  await chrome.storage.local.set({ [SETTINGS_KEY]: next })
  return next
}

export async function getSession() {
  const raw = await chrome.storage.local.get(SESSION_KEY)
  return raw[SESSION_KEY] || null
}

export async function setSession(session) {
  if (session) await chrome.storage.local.set({ [SESSION_KEY]: session })
  else await chrome.storage.local.remove(SESSION_KEY)
}

export async function getFavorites() {
  const raw = await chrome.storage.local.get(FAVORITES_KEY)
  return raw[FAVORITES_KEY] || []
}

export async function toggleFavorite(key) {
  const favs = await getFavorites()
  const next = favs.includes(key) ? favs.filter(k => k !== key) : [...favs, key]
  await chrome.storage.local.set({ [FAVORITES_KEY]: next })
  return next
}

export async function getGear(key) {
  const raw = await chrome.storage.local.get(GEAR_KEY)
  return (raw[GEAR_KEY] || {})[key] || null
}

export async function setGear(key, gear) {
  const raw = await chrome.storage.local.get(GEAR_KEY)
  const all = raw[GEAR_KEY] || {}
  all[key] = gear
  await chrome.storage.local.set({ [GEAR_KEY]: all })
}
