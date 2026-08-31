/**
 * Offscreen-документ: точный отсчёт и звук.
 *
 * Зачем он вообще: сервис-воркер MV3 выгружают через ~30 секунд простоя, а
 * chrome.alarms будит не чаще раза в минуту — для проливов по 8 секунд это не
 * годится. Документ живёт, пока идёт воспроизведение звука, поэтому во время
 * сессии он держит почти беззвучный тон-«якорь» и тикает обычным setTimeout.
 */

let timer = null       // таймаут до конца фазы
let beat = null        // посекундный интервал: бейдж + тики
let endAt = 0
let ticksOn = false
let vol = 0.6

// ── WebAudio ─────────────────────────────────────────────────────────────────

let ctx = null
let anchor = null      // тихий тон, удерживающий документ живым

function audio() {
  if (!ctx) ctx = new AudioContext()
  if (ctx.state === 'suspended') ctx.resume()
  return ctx
}

function startAnchor() {
  if (anchor) return
  const c = audio()
  const o = c.createOscillator()
  const g = c.createGain()
  o.type = 'sine'
  o.frequency.value = 40
  g.gain.value = 0.0001          // неслышно, но считается воспроизведением
  o.connect(g); g.connect(c.destination)
  o.start()
  anchor = { o, g }
}

function stopAnchor() {
  if (!anchor) return
  try { anchor.o.stop() } catch { /* уже остановлен */ }
  anchor = null
}

/** Мягкий многослойный гонг — конец шага. */
function playGong(volume = 0.6) {
  const c = audio()
  const now = c.currentTime
  const master = c.createGain()
  master.gain.setValueAtTime(0.0001, now)
  master.gain.exponentialRampToValueAtTime(Math.max(0.01, volume), now + 0.02)
  master.gain.exponentialRampToValueAtTime(0.0001, now + 2.8)
  master.connect(c.destination)
  ;[196, 392, 523.25, 784].forEach((f, i) => {
    const o = c.createOscillator(); const g = c.createGain()
    o.type = 'sine'; o.frequency.setValueAtTime(f, now)
    g.gain.setValueAtTime(1 / (i + 1.5), now)
    o.connect(g); g.connect(master)
    o.start(now); o.stop(now + 2.8)
  })
}

/** Короткий тик — обратный отсчёт 3-2-1. */
function playTick(volume = 0.6) {
  const c = audio()
  const now = c.currentTime
  const o = c.createOscillator(); const g = c.createGain()
  o.type = 'triangle'; o.frequency.setValueAtTime(880, now)
  g.gain.setValueAtTime(0.0001, now)
  g.gain.exponentialRampToValueAtTime(Math.max(0.01, volume * 0.5), now + 0.01)
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.12)
  o.connect(g); g.connect(c.destination)
  o.start(now); o.stop(now + 0.13)
}

// ── озвучка ──────────────────────────────────────────────────────────────────

let clipEl = null

/**
 * Сказать фразу: сначала записанный клип, иначе системный синтез.
 * Если клип есть, но не проигрался (битый файл, политика автоплея),
 * фраза не теряется — её дочитает синтез.
 */
function say({ text, clip, volume = 0.9, rate = 1 }) {
  if (!text) return
  if (clip) {
    try {
      if (clipEl) { try { clipEl.pause() } catch { /* уже остановлен */ } }
      clipEl = new Audio(clip)
      clipEl.volume = Math.min(1, Math.max(0, volume))
      const p = clipEl.play()
      if (p?.catch) p.catch(() => speak(text, volume, rate))
      return
    } catch { /* падаем в синтез */ }
  }
  speak(text, volume, rate)
}

/** Гонг, следом фраза — чтобы не звучали друг поверх друга. */
function announce({ gong, volume, text, clip, speechVolume = 0.9, rate = 1 }) {
  if (gong) playGong(volume ?? vol)
  if (!text) return
  setTimeout(() => say({ text, clip, volume: speechVolume, rate }), gong ? 1200 : 0)
}

function speak(text, volume, rate) {
  try {
    const u = new SpeechSynthesisUtterance(text)
    u.lang = 'ru-RU'
    u.volume = Math.min(1, Math.max(0, volume))
    u.rate = rate
    speechSynthesis.cancel()
    speechSynthesis.speak(u)
  } catch { /* синтез недоступен — остаётся уведомление и гонг */ }
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

  const delay = Math.max(0, endAt - Date.now())
  timer = setTimeout(fire, delay)

  let lastTick = -1
  beat = setInterval(() => {
    const left = Math.ceil((endAt - Date.now()) / 1000)
    chrome.runtime.sendMessage({ type: 'beat' }).catch(() => {})
    if (ticksOn && left > 0 && left <= 3 && left !== lastTick) {
      lastTick = left
      playTick(vol)
    }
    // setTimeout в фоновой вкладке могут придушить — подстраховываемся.
    if (left <= 0) fire()
  }, 1000)
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== 'offscreen') return
  if (msg.type === 'schedule') schedule(msg.at, msg.ticks, msg.volume)
  else if (msg.type === 'cancel') { clear(); stopAnchor() }
  else if (msg.type === 'announce') announce(msg)
})

// Просим воркер вернуть отсчёт: документ мог быть создан только что или
// перезапущен после выгрузки, и присланное до этого расписание потерялось.
chrome.runtime.sendMessage({ type: 'offscreen-ready' }).catch(() => {})
