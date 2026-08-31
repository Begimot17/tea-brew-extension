/** Обёртки над chrome.storage.local: настройки, сессия, избранное. */

import { PACK_CLASSIC } from './phrases.js'

export const DEFAULT_SETTINGS = {
  pack: PACK_CLASSIC,      // classic | neutral | sunboy
  name: '',                // подстановка {name}; пусто — фразы без имени
  sound: true,             // гонг в конце шага
  ticks: true,             // тики на последних 3 секундах
  volumeLevel: 0.6,        // громкость 0..1
  notifications: true,     // системные уведомления
  defaultVolume: 100,      // объём посуды по умолчанию, мл
  autoAdvance: true,       // сам переходить к следующему проливу
  gapSec: 0,               // 0 = авто (зависит от объёма), иначе фикс. пауза
}

const SETTINGS_KEY = 'settings'
const SESSION_KEY = 'session'
const FAVORITES_KEY = 'favorites'
const GEAR_KEY = 'gear'   // последняя посуда/навеска по сортам

export async function getSettings() {
  const raw = await chrome.storage.local.get(SETTINGS_KEY)
  return { ...DEFAULT_SETTINGS, ...(raw[SETTINGS_KEY] || {}) }
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
