/** Настройки: пишутся в chrome.storage.local сразу при изменении. */

import { getSettings, setSettings, DEFAULT_SETTINGS } from '../lib/storage.js'
import { PACKS, teaPhrase, generateSeed } from '../lib/phrases.js'
import { VOLUMES } from '../lib/brew.js'

const $ = id => document.getElementById(id)
const BOOLS = ['sound', 'ticks', 'notifications', 'speech']
const NUMS = ['volumeLevel', 'defaultVolume', 'speechVolume', 'speechRate']
const TEXTS = ['pack', 'name']

let settings = DEFAULT_SETTINGS

function fillSelects() {
  $('pack').append(...PACKS.map(p => new Option(p.name, p.id)))
  $('defaultVolume').append(...VOLUMES.map(v => new Option(`${v} мл`, String(v))))
}

function render() {
  for (const k of BOOLS) $(k).checked = !!settings[k]
  for (const k of NUMS) $(k).value = String(settings[k])
  for (const k of TEXTS) $(k).value = settings[k] ?? ''
  $('pack-hint').textContent = PACKS.find(p => p.id === settings.pack)?.hint || ''
  renderSample()
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
function flash() {
  $('saved').hidden = false
  clearTimeout(savedTimer)
  savedTimer = setTimeout(() => { $('saved').hidden = true }, 1200)
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

  $('test').addEventListener('click', () => {
    // Гонг играет offscreen-документ — тот же путь, что и в реальной заварке.
    chrome.runtime.sendMessage({ type: 'test-sound' })
  })
  $('test-voice').addEventListener('click', () => {
    // Озвучиваем ровно ту фразу, что показана в примере.
    chrome.runtime.sendMessage({ type: 'test-voice', text: sampleFirst() })
  })

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
}

init()
