/**
 * Мок Chrome-API, достаточный для того, чтобы прогнать настоящий
 * service-worker.js в node и проверить сценарии заварки целиком.
 *
 * Маршрутизация сообщений повторяет браузерную: sendMessage доставляется всем
 * слушателям, кроме отправителя, а ответ берётся у первого ответившего.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export function installChromeMock() {
  const store = new Map()
  const swListeners = []
  const offscreenListeners = []
  const alarmListeners = []

  // Что «прозвучало» — по этим счётчикам ловим дубли.
  const played = { gong: [], clip: [], tts: [] }
  const notifications = []
  let offscreenOpen = false

  // Документ отвечает так же, как настоящий: через sendResponse.
  const offscreenHandler = (msg, _sender, sendResponse) => {
    if (msg?.target !== 'offscreen') return undefined
    if (msg.type === 'gong') played.gong.push(msg.token ?? null)
    else if (msg.type === 'clip') played.clip.push({ clip: msg.clip, token: msg.token ?? null })
    sendResponse(true)
  }
  offscreenListeners.push(offscreenHandler)

  async function deliver(listeners, msg) {
    for (const fn of listeners) {
      let response
      let responded = false
      const sendResponse = v => { responded = true; response = v }
      const ret = fn(msg, { id: 'test' }, sendResponse)
      if (ret === true) {
        // Асинхронный ответ: ждём, пока обработчик его отдаст.
        for (let i = 0; i < 2000 && !responded; i++) await new Promise(r => setImmediate(r))
      } else if (ret !== undefined && typeof ret?.then === 'function') {
        response = await ret
        responded = true
      }
      if (responded) return response
    }
    return undefined
  }

  const chrome = {
    runtime: {
      onMessage: { addListener: fn => swListeners.push(fn) },
      onStartup: { addListener: () => {} },
      onInstalled: { addListener: () => {} },
      getURL: p => `chrome-extension://test/${p}`,
      getContexts: async () => (offscreenOpen ? [{ contextType: 'OFFSCREEN_DOCUMENT' }] : []),
      openOptionsPage: () => {},
      async sendMessage(msg) {
        // Документу — от воркера, воркеру — от документа и попапа.
        const target = msg?.target === 'offscreen' ? offscreenListeners : swListeners
        return deliver(target, msg)
      },
    },
    storage: {
      local: {
        async get(key) {
          const keys = key == null ? [...store.keys()] : Array.isArray(key) ? key : [key]
          const out = {}
          for (const k of keys) if (store.has(k)) out[k] = structuredClone(store.get(k))
          return out
        },
        async set(obj) { for (const [k, v] of Object.entries(obj)) store.set(k, structuredClone(v)) },
        async remove(key) { store.delete(key) },
        async clear() { store.clear() },
      },
      onChanged: { addListener: () => {} },
    },
    offscreen: {
      async createDocument() {
        if (offscreenOpen) throw new Error('Only a single offscreen document may be created')
        offscreenOpen = true
      },
      async closeDocument() { offscreenOpen = false },
    },
    alarms: {
      create: () => {},
      onAlarm: { addListener: fn => alarmListeners.push(fn) },
    },
    notifications: {
      create: (id, opts) => notifications.push({ id, ...opts }),
      clear: () => {},
      onClicked: { addListener: () => {} },
    },
    // Ровно как на машине пользователя: русского голоса в системе нет.
    tts: {
      getVoices: async () => [{ voiceName: 'Microsoft Zira Desktop', lang: 'en-US' }],
      speak: (text) => played.tts.push(text),
      stop: () => {},
    },
    action: {
      setBadgeText: () => {},
      setBadgeBackgroundColor: () => {},
    },
    tabs: { create: () => {} },
  }

  globalThis.chrome = chrome

  // Манифесты озвучки читаются fetch'ем — отдаём их прямо с диска.
  globalThis.fetch = async (url) => {
    const rel = String(url).replace('chrome-extension://test/', '')
    const path = fileURLToPath(new URL(`../../${rel}`, import.meta.url))
    try {
      const body = readFileSync(path, 'utf8')
      return { ok: true, json: async () => JSON.parse(body) }
    } catch {
      return { ok: false, json: async () => ({}) }
    }
  }

  return {
    store,
    played,
    notifications,
    isOffscreenOpen: () => offscreenOpen,
    fireAlarm: name => Promise.all(alarmListeners.map(fn => fn({ name }))),
    /** Сообщение воркеру — так же, как его шлёт попап. */
    toWorker: msg => deliver(swListeners, msg),
    session: () => store.get('session'),
  }
}
