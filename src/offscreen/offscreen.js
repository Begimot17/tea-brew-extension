/**
 * Offscreen-документ: точный отсчёт и звук.
 *
 * Зачем он вообще: сервис-воркер MV3 выгружают через ~30 секунд простоя, а
 * chrome.alarms будит не чаще раза в минуту — для проливов по 8 секунд это не
 * годится. Документ живёт, пока идёт воспроизведение звука, и тикает обычным
 * setTimeout.
 *
 * Звук — готовые файлы через <audio>, а не синтез на WebAudio: в
 * offscreen-документе нет и не может быть пользовательского жеста, поэтому
 * AudioContext остаётся приостановленным и не звучит вовсе. У <audio> в
 * документе с reason AUDIO_PLAYBACK такой проблемы нет.
 */

let timer = null       // таймаут до конца шага
let beat = null        // посекундный интервал: бейдж и тики
let endAt = 0
let ticksOn = false
let vol = 0.6

const GONG = chrome.runtime.getURL('src/assets/sounds/gong.wav')
const TICK = chrome.runtime.getURL('src/assets/sounds/tick.wav')

// ── звук ─────────────────────────────────────────────────────────────────────

/** Сообщить воркеру о проблеме — он покажет её в настройках. */
function report(message) {
  chrome.runtime.sendMessage({ type: 'audio-problem', message }).catch(() => {})
}

// Тихий зациклённый гонг держит документ живым: Chrome не выгружает
// offscreen-документ, пока тот действительно что-то воспроизводит.
const anchor = new Audio(GONG)
anchor.loop = true
anchor.volume = 0.0001

function startAnchor() {
  anchor.play().catch(() => { /* не критично: есть аларм и попап */ })
}

function stopAnchor() {
  try { anchor.pause() } catch { /* уже остановлен */ }
}

function play(src, volume) {
  try {
    const el = new Audio(src)
    el.volume = Math.min(1, Math.max(0, volume))
    return el.play().catch(err => report(`звук не проигрался: ${err?.message || err}`))
  } catch (err) {
    report(`звук не создался: ${err?.message || err}`)
  }
}

const playGong = (volume = vol) => play(GONG, volume)
const playTick = (volume = vol) => play(TICK, volume * 0.5)

// ── озвучка ──────────────────────────────────────────────────────────────────

let clipEl = null

/**
 * Записанный клип фразы. Синтез речи живёт в воркере (chrome.tts): в
 * offscreen-документе Web Speech API молчит.
 * Возвращает false, если клипа нет или он не заиграл — тогда воркер читает
 * фразу синтезом.
 */
async function sayClip({ clip, volume = 0.9 }) {
  if (!clip) return false
  try {
    if (clipEl) { try { clipEl.pause() } catch { /* уже остановлен */ } }
    clipEl = new Audio(clip)
    clipEl.volume = Math.min(1, Math.max(0, volume))
    await clipEl.play()
    return true
  } catch (err) {
    report(`клип не проигрался: ${err?.message || err}`)
    return false
  }
}

// ── планирование ─────────────────────────────────────────────────────────────

function clear() {
  if (timer) { clearTimeout(timer); timer = null }
  if (beat) { clearInterval(beat); beat = null }
}

function fire() {
  clear()
  chrome.runtime.sendMessage({ type: 'expired' }).catch(() => {})
}

function schedule(at, ticks, volume) {
  clear()
  endAt = at
  ticksOn = !!ticks
  vol = volume ?? vol
  startAnchor()

  timer = setTimeout(fire, Math.max(0, endAt - Date.now()))

  let lastTick = -1
  beat = setInterval(() => {
    const left = Math.ceil((endAt - Date.now()) / 1000)
    chrome.runtime.sendMessage({ type: 'beat' }).catch(() => {})
    if (ticksOn && left > 0 && left <= 3 && left !== lastTick) {
      lastTick = left
      playTick(vol)
    }
    // setTimeout в фоне могут придушить — подстраховываемся.
    if (left <= 0) fire()
  }, 1000)
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return

  if (msg.type === 'schedule') { schedule(msg.at, msg.ticks, msg.volume); sendResponse(true) }
  else if (msg.type === 'cancel') { clear(); stopAnchor(); sendResponse(true) }
  else if (msg.type === 'gong') { playGong(msg.volume); sendResponse(true) }
  else if (msg.type === 'clip') { sayClip(msg).then(sendResponse); return true }
  else if (msg.type === 'ping') sendResponse(true)
  else sendResponse(false)
})

// Просим воркер вернуть отсчёт: документ мог быть создан только что или
// перезапущен после выгрузки, и присланное до этого расписание потерялось.
chrome.runtime.sendMessage({ type: 'offscreen-ready' }).catch(() => {})
