/** Настройки: пишутся в chrome.storage.local сразу при изменении. */

import { getSettings, setSettings, DEFAULT_SETTINGS, voiceFor } from '../lib/storage.js'
import { PACKS, teaPhrase, generateSeed } from '../lib/phrases.js'
import { VOLUMES } from '../lib/brew.js'
import { VOICES } from '../lib/voice.js'

const $ = id => document.getElementById(id)
const BOOLS = ['sound', 'ticks', 'notifications', 'speech']
const NUMS = ['volumeLevel', 'defaultVolume', 'speechVolume', 'speechRate']
const TEXTS = ['pack', 'name']

let settings = DEFAULT_SETTINGS

function fillSelects() {
  $('pack').append(...PACKS.map(p => new Option(p.name, p.id)))
  $('voice').append(...VOICES.map(v => new Option(v.name, v.id)))
  $('defaultVolume').append(...VOLUMES.map(v => new Option(`${v} мл`, String(v))))
}

function render() {
  for (const k of BOOLS) $(k).checked = !!settings[k]
  for (const k of NUMS) $(k).value = String(settings[k])
  for (const k of TEXTS) $(k).value = settings[k] ?? ''
  $('pack-hint').textContent = PACKS.find(p => p.id === settings.pack)?.hint || ''
  // Голос свой у каждого набора, поэтому селект показывает голос текущего.
  $('voice').value = voiceFor(settings)
  $('voice-hint').textContent = VOICES.find(v => v.id === voiceFor(settings))?.hint || ''
  renderSample()
  renderVoiceCheck()
}

/** Живой пример: та же функция, что и в уведомлениях. */
function samplePhrases() {
  const seed = generateSeed(2024)
  return [0, 1, 2].map(i =>
    teaPhrase('steep', i, seed, settings.name || undefined, { pack: settings.pack, teaKey: 'shou_puer' }))
}

const sampleFirst = () => samplePhrases()[0]

function renderSample() {
  $('sample').textContent = samplePhrases().join(' · ')
}

let savedTimer = null

function status(text, ms = 3000) {
  $('saved').textContent = text
  $('saved').hidden = false
  clearTimeout(savedTimer)
  savedTimer = setTimeout(() => { $('saved').hidden = true }, ms)
}

const flash = () => status('Сохранено', 1200)

/** Спросить воркер и показать ответ. Ошибку тоже показываем, а не глотаем. */
async function ask(msg, format) {
  try {
    status(format(await chrome.runtime.sendMessage(msg)), 5000)
  } catch (err) {
    status(`Ошибка: ${err?.message || err}`, 6000)
  }
}

/** Сколько фраз набора озвучено выбранным голосом. */
async function renderVoiceCheck() {
  try {
    const r = await chrome.runtime.sendMessage({ type: 'voice-check', phrases: samplePhrases() })
    if (!r) return
    $('voice-hint').textContent = r.baked === r.total
      ? `${VOICES.find(v => v.id === r.voice)?.hint || ''} — фразы записаны`
      : `${VOICES.find(v => v.id === r.voice)?.hint || ''} — записано ${r.baked} из ${r.total}, остальное прочитает синтез`
  } catch { /* воркер поднимается */ }
}

/** Какие голоса вообще есть в системе — иначе тишина ничего не объясняет. */
async function renderVoices() {
  try {
    const r = await chrome.runtime.sendMessage({ type: 'voice-info' })
    if (r?.error) { $('voices').textContent = `Синтез недоступен: ${r.error}`; return }
    if (!r?.total) { $('voices').textContent = 'В системе не найдено ни одного голоса — синтез будет молчать'; return }
    $('voices').textContent = r.russian.length
      ? `Русские голоса: ${r.russian.join(', ')}`
      : `Русского голоса нет, будет читать: ${r.sample[0] || '—'}`
  } catch (err) {
    $('voices').textContent = `Не удалось спросить о голосах: ${err?.message || err}`
  }
}

async function save(patch) {
  settings = await setSettings(patch)
  render()
  flash()
}

function wire() {
  for (const k of BOOLS) $(k).addEventListener('change', e => save({ [k]: e.target.checked }))
  for (const k of NUMS) $(k).addEventListener('change', e => save({ [k]: Number(e.target.value) }))
  $('pack').addEventListener('change', e => save({ pack: e.target.value }))
  $('name').addEventListener('input', e => save({ name: e.target.value.trim() }))
  // Голос сохраняется под текущий набор, остальные наборы не трогаем.
  $('voice').addEventListener('change', e =>
    save({ voices: { ...settings.voices, [settings.pack]: e.target.value } }))

  // Проверки идут тем же путём, что и реальная заварка, и показывают результат:
  // молчащая кнопка не даёт понять, сломан звук или просто выключен.
  $('test').addEventListener('click', () => ask(
    { type: 'test-sound' },
    r => r?.ok ? 'Гонг отправлен' : `Не вышло: ${r?.problem || 'нет ответа от звукового документа'}`))

  $('test-voice').addEventListener('click', () => ask(
    { type: 'test-voice', text: sampleFirst() },
    r => r?.ok ? `Озвучено: ${r.via}` : `Не вышло: ${r?.problem || 'ни один способ озвучки не сработал'}`))

  $('reset-session').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'stop' })
    flash()
  })
  $('reset-all').addEventListener('click', async () => {
    if (!confirm('Очистить избранное, настройки и текущую заварку?')) return
    await chrome.runtime.sendMessage({ type: 'stop' })
    await chrome.storage.local.clear()
    settings = DEFAULT_SETTINGS
    render()
    flash()
  })
}

async function init() {
  fillSelects()
  settings = await getSettings()
  wire()
  render()
  renderVoices()
}

init()
