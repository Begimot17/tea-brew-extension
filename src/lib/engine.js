/**
 * Машина состояний заварки — чистые функции над объектом сессии.
 * Одна реализация на попап и на фоновый воркер: попап только рисует,
 * переходы считает движок.
 *
 * Таймер никогда не запускается сам. Между шагами сессия стоит в 'await' и
 * показывает, сколько продлится следующий пролив; запускает его пользователь,
 * когда действительно залил воду. Сколько времени уходит на слить и выпить,
 * расширение знать не может, поэтому и не угадывает.
 *
 * session = {
 *   v,                      // версия формата, см. storage.SESSION_VERSION
 *   teaKey, teaName, style, mode, seed, grams, volume,
 *   steps: [{ label, sec, rinse }],
 *   idx,                    // шаг, который идёт или ждёт запуска
 *   status: 'await' | 'running' | 'paused' | 'done',
 *   endTime,                // ms epoch конца шага (в 'running')
 *   leftMs,                 // остаток при паузе
 *   startedAt, doneSteeps, announcedIdx
 * }
 */

import { buildSteps, brewMode } from './brew.js'
import { SESSION_VERSION } from './storage.js'

export function createSession(tea, grams, volume, seed) {
  return {
    v: SESSION_VERSION,
    teaKey: tea.key, teaName: tea.name, style: tea.style || null,
    mode: brewMode(tea, grams, volume),
    seed, grams, volume, steps: buildSteps(tea, grams, volume),
    idx: 0, status: 'await',
    endTime: 0, leftMs: 0, startedAt: Date.now(), doneSteeps: 0,
  }
}

/** Шаг, который сейчас идёт или ждёт запуска. */
export function currentStep(session) {
  return session?.steps?.[session.idx] || null
}

export function leftMs(session, now = Date.now()) {
  if (!session) return 0
  if (session.status === 'paused') return session.leftMs
  if (session.status === 'running') return Math.max(0, session.endTime - now)
  // В ожидании показываем не остаток, а сколько шаг продлится.
  return (currentStep(session)?.sec || 0) * 1000
}

/** Запустить шаг, на котором стоим. */
export function startStep(session, now = Date.now()) {
  if (session.status !== 'await') return session
  const step = currentStep(session)
  if (!step) return { ...session, status: 'done' }
  return { ...session, status: 'running', endTime: now + step.sec * 1000, leftMs: 0 }
}

/**
 * Продвинуть сессию, если шаг истёк.
 * Возвращает { session, events } — events для звука и уведомлений.
 * Идемпотентна: вызывать можно хоть каждую секунду.
 */
export function tick(session, _settings, now = Date.now()) {
  const s = { ...session }
  if (s.status !== 'running' || now < s.endTime) return { session: s, events: [] }

  const step = s.steps[s.idx]
  const last = s.idx >= s.steps.length - 1
  const events = [{
    type: last ? 'finish' : (step.rinse ? 'rinse' : 'steep'),
    stepIndex: s.idx,
    label: step.label,
  }]

  return {
    session: {
      ...s,
      status: last ? 'done' : 'await',
      idx: last ? s.idx : s.idx + 1,
      doneSteeps: s.doneSteeps + (step.rinse ? 0 : 1),
      endTime: 0,
      leftMs: 0,
    },
    events,
  }
}

export function pause(session, now = Date.now()) {
  if (session.status !== 'running') return session
  return { ...session, status: 'paused', leftMs: Math.max(0, session.endTime - now) }
}

export function resume(session, now = Date.now()) {
  if (session.status !== 'paused') return session
  return { ...session, status: 'running', endTime: now + (session.leftMs || 0), leftMs: 0 }
}

/** Пропустить текущий шаг, не дожидаясь конца, — встаём перед следующим. */
export function skip(session) {
  if (session.status === 'done') return session
  const last = session.idx >= session.steps.length - 1
  if (last) return { ...session, status: 'done', endTime: 0, leftMs: 0 }
  return { ...session, idx: session.idx + 1, status: 'await', endTime: 0, leftMs: 0 }
}

/** ±секунды к текущему шагу. В ожидании правит длительность самого шага. */
export function shift(session, sec, now = Date.now()) {
  if (session.status === 'await') {
    const steps = session.steps.map((s, i) =>
      i === session.idx ? { ...s, sec: Math.max(3, s.sec + sec) } : s)
    return { ...session, steps }
  }
  if (session.status === 'paused')
    return { ...session, leftMs: Math.max(1000, session.leftMs + sec * 1000) }
  if (session.status !== 'running') return session
  return { ...session, endTime: Math.max(now + 1000, session.endTime + sec * 1000) }
}

/** Момент, когда воркеру нужно проснуться; null — таймер не идёт. */
export function nextWakeAt(session) {
  return session?.status === 'running' ? session.endTime : null
}
