/**
 * Живой прогон расширения в настоящем Chrome.
 *
 * Мок Chrome-API проверяет логику, но не проверяет, что расширение вообще
 * загрузилось: сломанный импорт, опечатка в манифесте или упавший на старте
 * скрипт видны только в браузере. Здесь всё это и ловится — попап открывается
 * как обычная страница, кнопки жмутся, состояние читается из хранилища.
 *
 * Запуск (браузер ставится через `npx playwright install chromium`):
 *     node tests/e2e.mjs
 */
import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const EXT = fileURLToPath(new URL('..', import.meta.url))
const profile = mkdtempSync(join(tmpdir(), 'tea-ext-'))

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✔' : '✖'} ${name}${detail && !ok ? ` — ${detail}` : ''}`)
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
})

try {
  // ── расширение поднялось ──
  let [sw] = ctx.serviceWorkers()
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 })
  const extId = new URL(sw.url()).host
  check('service worker загрузился', !!extId, sw.url())

  const errors = []
  ctx.on('weberror', e => errors.push(`страница: ${e.error().message}`))
  sw.on('console', m => { if (m.type() === 'error') errors.push(`worker: ${m.text()}`) })

  /** Состояние сессии глазами воркера. */
  const session = () => sw.evaluate(async () => (await chrome.storage.local.get('session')).session)
  const settings = () => sw.evaluate(async () => (await chrome.storage.local.get('settings')).settings)

  // ── попап ──
  const popup = await ctx.newPage()
  const popupErrors = []
  popup.on('pageerror', e => popupErrors.push(e.message))
  popup.on('console', m => { if (m.type() === 'error') popupErrors.push(m.text()) })
  await popup.goto(`chrome-extension://${extId}/src/popup/popup.html`)
  await popup.waitForSelector('#list li', { timeout: 10000 })

  const teaCount = await popup.locator('#list li:not(.group)').count()
  check('каталог отрисован', teaCount >= 18, `сортов: ${teaCount}`)

  // ── выбор чая и навески ──
  await popup.getByText('Шу пуэр', { exact: true }).first().click()
  await popup.waitForSelector('#gear:not([hidden])')
  const gramsValue = await popup.locator('#grams').inputValue()
  const preview = await popup.locator('#preview').textContent()
  const mode = await popup.locator('#mode').textContent()
  check('навеска предложена по объёму', gramsValue === '7', `граммы: ${gramsValue}`)
  check('превью показывает проливы', /пролив/.test(preview), preview)
  check('режим определён как гунфу', /Гунфу · 1:14/.test(mode), mode)

  // 500 мл — должен переключиться на западную заварку
  await popup.locator('#volumes .chip', { hasText: '500' }).click()
  await popup.locator('#grams').fill('8')
  await popup.locator('#grams').dispatchEvent('input')
  const modeWestern = await popup.locator('#mode').textContent()
  const previewWestern = await popup.locator('#preview').textContent()
  check('8 г на 500 мл — западная заварка', /Западная заварка · 1:63/.test(modeWestern), modeWestern)
  check('и это 3 настоя, а не десяток проливов', /^3 настоя/.test(previewWestern), previewWestern)

  // Возвращаемся к гунфу — с ним удобнее гонять шаги.
  await popup.locator('#volumes .chip', { hasText: '100' }).first().click()
  await popup.locator('#grams').fill('7')
  await popup.locator('#grams').dispatchEvent('input')

  // ── заварка ──
  await popup.locator('#start').click()
  await popup.waitForSelector('#brew:not([hidden])')
  let s = await session()
  check('сессия создана и ждёт старта', s?.status === 'await' && s.idx === 0, JSON.stringify(s?.status))

  const toggleBefore = await popup.locator('#toggle').textContent()
  const clockBefore = await popup.locator('#clock').textContent()
  check('кнопка предлагает «Старт»', toggleBefore === 'Старт', toggleBefore)
  check('на часах — длительность шага', clockBefore === '0:06', clockBefore)

  // Главное: «Старт» запускает таймер, а не выкидывает назад.
  await popup.locator('#toggle').click()
  await sleep(400)
  s = await session()
  const brewVisible = await popup.locator('#brew').isVisible()
  check('«Старт» запустил отсчёт', s?.status === 'running', `статус: ${s?.status}`)
  check('«Старт» не вернул к списку чаёв', brewVisible, 'экран заварки закрылся')
  check('кнопка стала «Пауза»', (await popup.locator('#toggle').textContent()) === 'Пауза')

  // ── конец шага: один гонг, одна фраза ──
  // Перехватываем то, что воркер отправляет звуковому документу: дубль
  // объявления виден здесь как две одинаковые команды.
  await sw.evaluate(() => {
    globalThis.__plays = []
    const orig = chrome.runtime.sendMessage.bind(chrome.runtime)
    chrome.runtime.sendMessage = (msg, ...rest) => {
      if (msg?.target === 'offscreen' && (msg.type === 'gong' || msg.type === 'clip'))
        globalThis.__plays.push(msg.type)
      return orig(msg, ...rest)
    }
  })

  // Ждём, пока шаг (6 секунд) отработает сам.
  await sleep(9000)
  s = await session()
  check('шаг закончился и сессия ждёт следующего', s?.status === 'await' && s.idx === 1,
    `статус ${s?.status}, шаг ${s?.idx}`)
  check('шаг объявлен ровно один раз', s?.announcedIdx === 0, `announcedIdx: ${s?.announcedIdx}`)

  const plays = await sw.evaluate(() => globalThis.__plays)
  check('гонг прозвучал один раз', plays.filter(p => p === 'gong').length === 1, plays.join(','))
  check('фраза прозвучала один раз', plays.filter(p => p === 'clip').length === 1, plays.join(','))

  // Те же сигналы, что в жизни приходят разом от документа, попапа и аларма.
  await sw.evaluate(async () => {
    await Promise.all([
      chrome.runtime.sendMessage({ type: 'expired' }).catch(() => {}),
      chrome.runtime.sendMessage({ type: 'sync' }).catch(() => {}),
      chrome.runtime.sendMessage({ type: 'expired' }).catch(() => {}),
    ])
  })
  await sleep(500)
  const playsAfter = await sw.evaluate(() => globalThis.__plays)
  check('повторные сигналы ничего не переигрывают',
    playsAfter.length === plays.length, playsAfter.join(','))

  const toggleAfter = await popup.locator('#toggle').textContent()
  check('кнопка снова «Старт»', toggleAfter === 'Старт', toggleAfter)

  const clockAfter = await popup.locator('#clock').textContent()
  check('на часах — длительность следующего шага', clockAfter === '0:06', clockAfter)

  // ── второй шаг по кнопке ──
  await popup.locator('#toggle').click()
  await sleep(400)
  s = await session()
  check('второй шаг тоже запускается кнопкой', s?.status === 'running' && s.idx === 1,
    `статус ${s?.status}, шаг ${s?.idx}`)

  // ── пропуск и остановка ──
  await popup.locator('#next').click()
  await sleep(300)
  s = await session()
  check('«Пропустить» переводит к следующему шагу', s?.status === 'await' && s.idx === 2,
    `статус ${s?.status}, шаг ${s?.idx}`)

  await popup.locator('#stop').click()
  await sleep(300)
  check('«Завершить» стирает сессию', (await session()) === undefined)
  check('после остановки виден список чаёв', await popup.locator('#pick').isVisible())

  // ── сессия от прошлой версии не должна ломать заварку ──
  await sw.evaluate(() => chrome.storage.local.set({
    session: { status: 'gap', idx: 3, teaName: 'Из прошлой версии', endTime: Date.now() + 9e5 },
  }))
  const revisit = await ctx.newPage()
  await revisit.goto(`chrome-extension://${extId}/src/popup/popup.html`)
  await revisit.waitForSelector('#list li', { timeout: 10000 })
  check('несовместимая сессия отброшена', await revisit.locator('#pick').isVisible())
  check('и стёрта из хранилища', (await session()) === undefined)
  await revisit.close()

  // ── настройки ──
  const options = await ctx.newPage()
  const optionErrors = []
  options.on('pageerror', e => optionErrors.push(e.message))
  await options.goto(`chrome-extension://${extId}/src/options/options.html`)
  await options.waitForSelector('#pack')
  const voiceValue = await options.locator('#voice').inputValue()
  check('в настройках выбран голос набора', voiceValue === 'dmitry', voiceValue)

  await options.locator('#test-voice').click()
  await options.waitForSelector('#saved:not([hidden])', { timeout: 10000 })
  const voiceStatus = await options.locator('#saved').textContent()
  check('проверка голоса отвечает результатом', /Озвучено/.test(voiceStatus), voiceStatus)

  await options.locator('#pack').selectOption('sunboy')
  await sleep(300)
  const sunboyVoice = await options.locator('#voice').inputValue()
  check('у набора Пророка свой голос', sunboyVoice === 'sunboy', sunboyVoice)
  const cfg = await settings()
  check('выбор голоса сохраняется по наборам',
    cfg?.voices?.classic === 'dmitry' && cfg?.voices?.sunboy === 'sunboy', JSON.stringify(cfg?.voices))

  check('в консоли попапа нет ошибок', popupErrors.length === 0, popupErrors.join(' | '))
  check('в консоли настроек нет ошибок', optionErrors.length === 0, optionErrors.join(' | '))
  check('воркер не ругался', errors.length === 0, errors.join(' | '))
} finally {
  await ctx.close()
  rmSync(profile, { recursive: true, force: true })
}

const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} проверок пройдено`)
if (failed.length) {
  console.log('\nНе прошло:')
  for (const f of failed) console.log(`  ✖ ${f.name} — ${f.detail}`)
  process.exit(1)
}
