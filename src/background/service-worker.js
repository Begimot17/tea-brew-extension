/**
 * Фоновый воркер: владеет сессией заварки и уведомлениями.
 *
 * Шаги гунфу-заварки длятся 5–30 секунд, а chrome.alarms не умеет будить чаще
 * раза в минуту, поэтому точные тики даёт offscreen-документ (он же играет гонг):
 * воркер отдаёт ему момент срабатывания, тот возвращает 'expired'. Аларм на
 * минуту остаётся страховкой на случай, если воркер и документ выгрузят.
 */

import { getSettings, getSession, setSession } from '../lib/storage.js'
import { tick, pause, resume, next, shift, nextWakeAt, createSession } from '../lib/engine.js'
import { teaPhrase, teaNotificationTitle, generateSeed } from '../lib/phrases.js'
import { fmt } from '../lib/brew.js'
import { clipUrl } from '../lib/voice.js'

const OFFSCREEN_PATH = 'src/offscreen/offscreen.html'
const KEEPALIVE_ALARM = 'tea-keepalive'
const NOTIF_ID = 'tea-step'

// ── offscreen ────────────────────────────────────────────────────────────────

let creating = null

async function hasOffscreen() {
  if (chrome.runtime.getContexts) {
    const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })
    return ctx.length > 0
  }
  return false
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return
  if (creating) return creating
  creating = chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['AUDIO_PLAYBACK'],
    justification: 'Отсчёт шагов заварки, гонг и озвучка фразы в конце пролива.',
  }).catch(err => {
    // «Only a single offscreen document» — гонка с параллельным созданием,
    // документ уже есть и всё в порядке. Остальное стоит показать.
    if (!String(err?.message || err).includes('single offscreen')) throw err
  }).finally(() => { creating = null })
  return creating
}

async function closeOffscreen() {
  if (await hasOffscreen()) await chrome.offscreen.closeDocument().catch(() => {})
}

/**
 * createDocument резолвится, когда документ создан, но его модуль к этому
 * моменту может ещё не выполниться и слушателя сообщений нет — первое
 * сообщение тогда уходит в пустоту. Поэтому шлём с повторами; вдобавок сам
 * документ, загрузившись, просит перепланировать (см. 'offscreen-ready').
 */
async function toOffscreen(msg, attempts = 4) {
  try {
    await ensureOffscreen()
  } catch (err) {
    lastAudioProblem = `offscreen-документ не создался: ${err?.message || err}`
    return false
  }
  for (let i = 0; i < attempts; i++) {
    try {
      return await chrome.runtime.sendMessage({ target: 'offscreen', ...msg })
    } catch (err) {
      if (i === attempts - 1) lastAudioProblem = `offscreen не отвечает: ${err?.message || err}`
      await new Promise(r => setTimeout(r, 60 * (i + 1)))
    }
  }
  return false
}

/** Последняя проблема со звуком — показывается в настройках по кнопке проверки. */
let lastAudioProblem = ''

// ── уведомления и звук ───────────────────────────────────────────────────────

async function announce(session, settings, events) {
  for (const ev of events) {
    const phrase = teaPhrase(ev.type, ev.stepIndex, session.seed, settings.name || undefined, {
      pack: settings.pack, teaKey: session.teaKey,
    })
    if (settings.notifications) {
      chrome.notifications.create(`${NOTIF_ID}-${ev.stepIndex}`, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: teaNotificationTitle(settings.pack),
        message: phrase,
        contextMessage: ev.type === 'finish'
          ? `${session.teaName} · ${session.doneSteeps} проливов`
          : `${session.teaName} · ${ev.label}`,
        silent: true,
        priority: 2,
      })
    }
    if (settings.sound) await toOffscreen({ type: 'gong', volume: settings.volumeLevel })
    if (settings.speech) await say(phrase, settings, settings.sound ? 1400 : 0)
  }
}

/**
 * Озвучить фразу: записанным клипом, если он есть, иначе системным синтезом.
 *
 * Синтез зовём через chrome.tts, а не Web Speech API: в offscreen-документе
 * speechSynthesis молчит, а вкладки у расширения нет. Гонг звучит около трёх
 * секунд, поэтому фразу пускаем с задержкой, чтобы не накладывались.
 */
async function say(phrase, settings, delay = 0) {
  if (delay) await new Promise(r => setTimeout(r, delay))
  const clip = await clipUrl(phrase, settings.pack)
  if (clip && await toOffscreen({ type: 'clip', clip, volume: settings.speechVolume }) === true) return
  speak(phrase, settings)
}

/** Системный синтез речи. */
function speak(text, settings) {
  try {
    chrome.tts.speak(text, {
      lang: 'ru-RU',
      rate: settings.speechRate,
      volume: settings.speechVolume,
      enqueue: true,
      onEvent: e => { if (e.type === 'error') lastAudioProblem = `синтез речи: ${e.errorMessage || 'ошибка'}` },
    })
  } catch (err) {
    lastAudioProblem = `синтез речи недоступен: ${err?.message || err}`
  }
}

// ── основной цикл ────────────────────────────────────────────────────────────

async function schedule(session, settings) {
  const wake = nextWakeAt(session)
  if (wake == null) {
    // Только останавливаем отсчёт. Документ не закрываем: он ещё доигрывает
    // гонг и фразу, а без сессии Chrome сам выгрузит его по бездействию.
    await toOffscreen({ type: 'cancel' })
    return
  }
  await toOffscreen({
    type: 'schedule',
    at: wake,
    ticks: settings.ticks,
    volume: settings.volumeLevel,
  })
}

/** Пересчитать истёкшие фазы, разослать события, перепланировать. */
async function advance() {
  const session = await getSession()
  if (!session) { await closeOffscreen(); return null }
  const settings = await getSettings()
  const { session: nextS, events } = tick(session, settings)
  if (events.length) await announce(nextS, settings, events)
  await setSession(nextS)
  await schedule(nextS, settings)
  return nextS
}

/** Изменить сессию функцией-мутатором и перепланировать. */
async function mutate(fn) {
  const session = await getSession()
  if (!session) return null
  const settings = await getSettings()
  const nextS = fn(session, settings)
  await setSession(nextS)
  await schedule(nextS, settings)
  return nextS
}

// ── сообщения от попапа и offscreen ──────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target === 'offscreen') return   // не наше — адресовано документу

  ;(async () => {
    switch (msg?.type) {
      case 'start': {
        const settings = await getSettings()
        const session = createSession(msg.tea, msg.grams, msg.volume, generateSeed())
        await setSession(session)
        await schedule(session, settings)
        sendResponse(session)
        break
      }
      case 'expired':
        sendResponse(await advance())
        break
      case 'offscreen-ready': {
        // Документ поднялся (или перезапустился) — вернуть ему текущий отсчёт.
        const cur = await getSession()
        if (cur) await schedule(cur, await getSettings())
        sendResponse(null)
        break
      }
      case 'audio-problem':
        lastAudioProblem = msg.message || ''
        sendResponse(null)
        break
      case 'beat':
        paintBadge()
        sendResponse(null)
        break
      case 'pause':
        sendResponse(await mutate(s => pause(s)))
        break
      case 'resume':
        sendResponse(await mutate(s => resume(s)))
        break
      case 'next':
        sendResponse(await mutate(s => next(s)))
        break
      case 'shift':
        sendResponse(await mutate(s => shift(s, msg.sec)))
        break
      case 'stop':
        await setSession(null)
        await toOffscreen({ type: 'cancel' })
        try { chrome.tts.stop() } catch { /* синтез не запускался */ }
        await closeOffscreen()
        chrome.notifications.clear(NOTIF_ID)
        sendResponse(null)
        break
      case 'test-sound': {
        lastAudioProblem = ''
        const cfg = await getSettings()
        const ok = await toOffscreen({ type: 'gong', volume: cfg.volumeLevel })
        sendResponse({ ok: ok === true, problem: lastAudioProblem })
        break
      }
      case 'test-voice': {
        lastAudioProblem = ''
        const cfg = await getSettings()
        const clip = await clipUrl(msg.text, cfg.pack)
        await say(msg.text, cfg)
        sendResponse({
          ok: !lastAudioProblem,
          via: clip ? 'записанный голос' : 'системный синтез',
          problem: lastAudioProblem,
        })
        break
      }
      case 'sync':
        sendResponse(await advance())
        break
      default:
        sendResponse(null)
    }
  })()

  return true   // ответ асинхронный
})

// ── страховка на случай выгрузки воркера ─────────────────────────────────────

chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 })
chrome.alarms.onAlarm.addListener(a => { if (a.name === KEEPALIVE_ALARM) advance() })
chrome.runtime.onStartup.addListener(() => advance())
chrome.runtime.onInstalled.addListener(() => advance())

// Клик по уведомлению открывает попап-страницу с текущей заваркой.
chrome.notifications.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/popup/popup.html') })
})

// Показать остаток на бейдже иконки, чтобы не открывать попап ради времени.
async function paintBadge() {
  const session = await getSession()
  if (!session || session.status === 'done') { chrome.action.setBadgeText({ text: '' }); return }
  const left = Math.max(0, Math.round((session.endTime - Date.now()) / 1000))
  // На бейдж влезает 4 символа: до минуты — секунды, дальше mm:ss.
  const label = session.status === 'paused' ? '||' : left < 60 ? String(left) : fmt(left)
  chrome.action.setBadgeBackgroundColor({ color: '#8a4b2a' })
  chrome.action.setBadgeText({ text: label })
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.session) paintBadge()
})
