/**
 * Попап: выбор чая → навеска → заварка.
 * Состояние таймера живёт в фоновом воркере, попап его только рисует —
 * поэтому закрытие окна ничего не ломает.
 */

import {
  VOLUMES, buildSteps, recommendedGrams, steepCount, totalSec,
  fmt, plural, steepWord, timeFit, steepHint, teaGroup,
} from '../lib/brew.js'
import { teaPhrase } from '../lib/phrases.js'
import { getSettings, getFavorites, toggleFavorite, getGear, setGear, getSession } from '../lib/storage.js'

const $ = id => document.getElementById(id)
const screens = { pick: $('pick'), gear: $('gear'), brew: $('brew') }

let catalog = []
let settings = null
let favorites = []
let tea = null            // выбранный сорт
let volume = 100
let grams = 0
let gramsTouched = false
let session = null
let raf = null

// ── экраны ───────────────────────────────────────────────────────────────────

function show(name) {
  for (const [k, el] of Object.entries(screens)) el.hidden = k !== name
}

// ── список сортов ────────────────────────────────────────────────────────────

function renderList(query = '') {
  const q = query.trim().toLowerCase()
  const match = t => !q || t.name.toLowerCase().includes(q) || t.category.toLowerCase().includes(q)
  const items = catalog.filter(match)

  const favs = items.filter(t => favorites.includes(t.key))
  const rest = items.filter(t => !favorites.includes(t.key))
  const ul = $('list')
  ul.textContent = ''

  const addGroup = label => {
    const li = document.createElement('li')
    li.className = 'group'
    li.textContent = label
    ul.append(li)
  }
  const addTea = t => {
    const li = document.createElement('li')
    li.tabIndex = 0
    li.innerHTML = `<span class="emoji"></span>
      <span class="meta"><div class="nm"></div><div class="cat"></div></span>
      <span class="star"></span>`
    li.querySelector('.emoji').textContent = t.emoji
    li.querySelector('.nm').textContent = t.name
    li.querySelector('.cat').textContent = t.category
    li.querySelector('.star').textContent = favorites.includes(t.key) ? '★' : ''
    li.addEventListener('click', () => openGear(t))
    li.addEventListener('keydown', e => { if (e.key === 'Enter') openGear(t) })
    ul.append(li)
  }

  if (favs.length) { addGroup('Избранное'); favs.forEach(addTea) }

  let group = null
  for (const t of rest) {
    const g = teaGroup(t)
    if (g !== group) { addGroup(g); group = g }
    addTea(t)
  }
}

// ── настройка заварки ────────────────────────────────────────────────────────

async function openGear(t) {
  tea = t
  const saved = await getGear(t.key)
  volume = saved?.volume ?? settings.defaultVolume
  grams = saved?.grams ?? recommendedGrams(t, volume)
  gramsTouched = !!saved?.grams && saved.grams !== recommendedGrams(t, volume)

  $('gear-emoji').textContent = t.emoji
  $('gear-name').textContent = t.name
  const fit = timeFit(t)
  $('gear-fit').textContent = fit ? `${fit.emoji} ${fit.text}` : ''
  $('fav').textContent = favorites.includes(t.key) ? '★' : '☆'
  $('fav').classList.toggle('on', favorites.includes(t.key))

  renderVolumes()
  renderGear()
  show('gear')
}

function renderVolumes() {
  const box = $('volumes')
  box.textContent = ''
  for (const v of VOLUMES) {
    const b = document.createElement('button')
    b.className = 'chip'
    b.type = 'button'
    b.textContent = `${v}`
    b.setAttribute('aria-pressed', String(v === volume))
    b.addEventListener('click', () => {
      volume = v
      // Навеска следует за объёмом, пока её не трогали руками.
      if (!gramsTouched) grams = recommendedGrams(tea, volume)
      renderVolumes(); renderGear()
    })
    box.append(b)
  }
}

function renderGear() {
  $('grams').value = String(grams)
  const rec = recommendedGrams(tea, volume)
  $('grams-hint').textContent = gramsTouched
    ? `Рекомендуется ${rec} г на ${volume} мл`
    : `${tea.grams_per_100ml} г / 100 мл — эталон сорта`
  $('grams-reset').hidden = !gramsTouched

  const n = steepCount(tea, grams, volume)
  const steps = buildSteps(tea, grams, volume)
  const total = totalSec(steps)
  const w = plural(n, steepWord(tea.style))
  const rinses = tea.rinses ? ` · ${tea.rinses} ${plural(tea.rinses, ['промывка', 'промывки', 'промывок'])}` : ''
  $('preview').textContent = `${n} ${w} · ~${Math.round(total / 60)} мин${rinses}`
  $('temp').textContent = `${tea.temp} °C · ${tea.tips || ''}`
}

function setGrams(v) {
  grams = Math.max(0.1, Math.round(v * 10) / 10)
  gramsTouched = true
  renderGear()
}

// ── заварка ──────────────────────────────────────────────────────────────────

/** Каталожная запись для подсказок, если попап открыт без выбранного сорта. */
function teaFromSession() {
  return {
    style: session.style,
    rinses: session.steps.filter(s => s.rinse).length,
    desc: '',
  }
}

function renderBrew() {
  if (!session) return
  const step = session.steps[session.idx]
  $('brew-name').textContent = session.teaName

  const waiting = session.status === 'await'
  $('step-label').textContent = session.status === 'done'
    ? 'Сессия завершена'
    : waiting
      ? `${step.label} готов — снимай`
      : `${step.label} · ${steepHint(tea || teaFromSession(), session.idx)}`

  if (session.status === 'done') {
    const mins = Math.round((Date.now() - session.startedAt) / 60000)
    $('clock').textContent = '🍵'
    $('phrase').textContent = `${session.doneSteeps} ${plural(session.doneSteeps, steepWord(session.style))} · ${mins} мин`
  } else if (waiting) {
    // Таймер отработал и стоит: следующий пролив запускает пользователь.
    const nextStep = session.steps[session.idx + 1]
    $('clock').textContent = nextStep ? fmt(nextStep.sec) : '0:00'
    $('phrase').textContent = teaPhrase(step.rinse ? 'rinse' : 'steep', session.idx, session.seed,
      settings.name || undefined, { pack: settings.pack, teaKey: session.teaKey })
  } else {
    const left = session.status === 'paused'
      ? session.leftMs
      : Math.max(0, session.endTime - Date.now())
    $('clock').textContent = fmt(Math.ceil(left / 1000))
    $('phrase').textContent = ''
  }

  const dots = $('dots')
  dots.textContent = ''
  session.steps.forEach((s, i) => {
    const d = document.createElement('span')
    d.className = 'dot' + (s.rinse ? ' rinse' : '') +
      (i < session.idx ? ' done' : i === session.idx ? ' cur' : '')
    d.title = `${s.label} · ${fmt(s.sec)}`
    dots.append(d)
  })

  const done = session.status === 'done'
  // В ожидании кнопка «Пауза» бессмысленна — таймер и так стоит.
  $('toggle').hidden = waiting
  $('toggle').textContent = done ? 'Заново' : session.status === 'paused' ? 'Продолжить' : 'Пауза'
  const nextStep = session.steps[session.idx + 1]
  $('next').textContent = waiting
    ? (nextStep ? `Следующий: ${nextStep.label} · ${fmt(nextStep.sec)}` : 'Завершить')
    : 'Дальше'
  $('next').classList.toggle('primary', waiting)
  $('next').classList.toggle('ghost', !waiting)
  $('next').disabled = done
  $('minus').disabled = done || waiting
  $('plus').disabled = done || waiting
}

let syncing = false
let lastNudge = 0

/**
 * Досчитал до нуля — просим воркер продвинуть сессию.
 * Обычно он делает это сам по сигналу offscreen-документа, но воркер могли
 * выгрузить; при открытом попапе ждать до минутного аларма незачем.
 */
async function nudge() {
  // rAF зовёт нас 60 раз в секунду — воркеру хватит и одного запроса в 300 мс.
  if (syncing || Date.now() - lastNudge < 300) return
  syncing = true
  lastNudge = Date.now()
  try {
    const fresh = await chrome.runtime.sendMessage({ type: 'sync' })
    if (fresh) { session = fresh; renderBrew() }
  } catch { /* воркер поднимается */ } finally {
    syncing = false
  }
}

function loop() {
  cancelAnimationFrame(raf)
  const step = () => {
    renderBrew()
    const live = session && session.status === 'running'
    if (live && session.endTime - Date.now() <= 0) nudge()
    if (live) raf = requestAnimationFrame(step)
  }
  step()
}

async function send(msg) {
  session = await chrome.runtime.sendMessage(msg)
  if (!session) { show('pick'); return }
  show('brew')
  loop()
}

// ── события ──────────────────────────────────────────────────────────────────

function wire() {
  $('search').addEventListener('input', e => renderList(e.target.value))
  $('to-options').addEventListener('click', () => chrome.runtime.openOptionsPage())

  $('gear-back').addEventListener('click', () => show('pick'))
  $('brew-back').addEventListener('click', () => show('pick'))

  $('fav').addEventListener('click', async () => {
    favorites = await toggleFavorite(tea.key)
    const on = favorites.includes(tea.key)
    $('fav').textContent = on ? '★' : '☆'
    $('fav').classList.toggle('on', on)
    renderList($('search').value)
  })

  document.querySelectorAll('[data-grams]').forEach(b =>
    b.addEventListener('click', () => setGrams(grams + Number(b.dataset.grams))))
  $('grams').addEventListener('input', e => {
    const v = Number(e.target.value)
    if (v > 0) { grams = Math.round(v * 10) / 10; gramsTouched = true; renderGear() }
  })
  $('grams-reset').addEventListener('click', () => {
    grams = recommendedGrams(tea, volume); gramsTouched = false; renderGear()
  })

  $('start').addEventListener('click', async () => {
    await setGear(tea.key, { grams, volume })
    await send({ type: 'start', tea, grams, volume })
  })

  $('toggle').addEventListener('click', async () => {
    if (!session) return
    if (session.status === 'done') { await send({ type: 'start', tea, grams, volume }); return }
    await send({ type: session.status === 'paused' ? 'resume' : 'pause' })
  })
  $('next').addEventListener('click', () => send({ type: 'next' }))
  $('minus').addEventListener('click', () => send({ type: 'shift', sec: -5 }))
  $('plus').addEventListener('click', () => send({ type: 'shift', sec: 5 }))
  $('stop').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'stop' })
    session = null
    show('pick')
  })

  // Фон мог продвинуть сессию, пока попап был закрыт или пока идёт шаг.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.session) return
    session = changes.session.newValue || null
    if (session) { show('brew'); loop() }
  })
}

// ── старт ────────────────────────────────────────────────────────────────────

async function init() {
  const [cat, cfg, favs] = await Promise.all([
    fetch(chrome.runtime.getURL('src/data/tea.json')).then(r => r.json()),
    getSettings(),
    getFavorites(),
  ])
  catalog = cat
  settings = cfg
  favorites = favs
  volume = cfg.defaultVolume

  wire()
  renderList()

  // Незавершённая заварка — открываем сразу её.
  const active = await getSession()
  if (active) {
    tea = catalog.find(t => t.key === active.teaKey) || null
    grams = active.grams; volume = active.volume
    await send({ type: 'sync' })
  } else {
    show('pick')
  }
}

init()
