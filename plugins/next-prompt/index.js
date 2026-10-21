/**
 * Host half of the next-prompt bundle.
 *
 * One authenticated exact Fetch route below `/api` streams Server-Sent Events:
 * `{type:'text', text}` while the prediction is being generated and one
 * `{type:'done', text}` when it settles. Predictions use the Session's own
 * provider/model, the lowest reasoning effort, and a per-session cache keyed by
 * the Session sequence so an unchanged conversation answers instantly.
 */

import { appendFileSync } from 'node:fs'

const ENDPOINT = '/api/next-prompt/suggest'
const MAX_TRANSCRIPT_CHARS = 3200
const MAX_MESSAGE_CHARS = 700
const MAX_SUGGESTION_CHARS = 160
const LLM_TIMEOUT_MS = 12000

/** sessionId -> { seq, text }: identical state reuses the previous prediction. */
const PREDICTION_CACHE = new Map()

/** Lowest reasoning effort each route offers; prediction never needs thinking. */
const EFFORT_CACHE = new Map()

const SYSTEM_PROMPT = [
  'You predict the next message a user will type in a coding-agent conversation.',
  'Read the transcript and write the single most likely next user request as plain text.',
  'Rules:',
  '- Reply with the message only: no quotes, no JSON, no markdown, no "User:" prefix.',
  '- One short sentence, at most 120 characters.',
  '- Write in the same language the user writes in.',
  '- Make it a concrete action for the agent: run tests, fix the error, commit, explain a diff, continue the plan.',
  '- Never write as the assistant.',
  '- If the task looks finished or no next step is obvious, reply exactly SKIP.',
].join('\n')

export const inject = ['llm', 'agents', 'connection']

function logDebug(line) {
  try {
    appendFileSync('/tmp/np-debug.log', `${new Date().toISOString()} ${line}\n`)
  } catch {
    // Diagnostics only.
  }
}

async function pickEffort(ctx, route) {
  const key = `${route.provider}/${route.model}`
  if (EFFORT_CACHE.has(key)) return EFFORT_CACHE.get(key)
  let effort
  try {
    const info = await ctx.llm.resolveModelInfo(route.provider, route.model)
    const ids = (info.reasoning?.efforts ?? []).map((entry) => entry.id)
    if (ids.includes('off')) effort = 'off'
    else if (ids.includes('low')) effort = 'low'
  } catch {
    effort = undefined
  }
  EFFORT_CACHE.set(key, effort)
  return effort
}

/** One activation-time probe: exercises the real Session and model route. */
async function selfTest(ctx) {
  try {
    const agent = ctx.agents.roots()[0] ?? ctx.agents.list()[0]
    if (agent === undefined) {
      logDebug('selftest: no live agent')
      return
    }
    const target = agent.session?.id ?? agent.sessionId
    const diag = { session: String(target), mode: 'selftest' }
    const text = await streamPrediction(ctx, target, new AbortController().signal, () => {}, diag)
    logDebug(`selftest ${JSON.stringify({ ...diag, text })}`)
  } catch (error) {
    logDebug(`selftest error ${String(error?.message ?? error)}`)
  }
}

export function apply(ctx) {
  // `register` already owns its effect on this Context; wrapping it again would
  // dispose the same route twice. The activation probe is opt-in: it costs one
  // model call.
  if (process.env.DSH_NEXT_PROMPT_SELFTEST === '1') void selfTest(ctx)

  ctx.effect(() => ctx.connection.fetch.register({
    path: ENDPOINT,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: (request) => handleRequest(ctx, request),
  }))
}

async function handleRequest(ctx, request) {
  let payload
  try {
    payload = await request.json()
  } catch {
    return json({ text: null }, 400)
  }
  const sessionId = payload && typeof payload.sessionId === 'string' ? payload.sessionId : null
  if (!sessionId) return json({ text: null }, 400)

  const started = Date.now()
  const diag = {}
  if (typeof payload.reason === 'string') diag.reason = payload.reason

  return sse(async (emit) => {
    let text = null
    try {
      text = await streamPrediction(ctx, sessionId, request.signal, emit, diag)
    } catch (error) {
      diag.error = String(error?.message ?? error)
    } finally {
      diag.ms = Date.now() - started
      diag.text = text
      logDebug(`request ${JSON.stringify(diag)}`)
    }
    return text
  })
}

/**
 * Generate one prediction, emitting incremental text as it arrives.
 * @returns the cleaned final text, or null when nothing usable was produced.
 */
async function streamPrediction(ctx, sessionId, signal, emit, diag) {
  const agent = ctx.agents.get(sessionId)
  diag.agent = agent !== undefined
  if (agent === undefined) return null

  const seq = agent.session.seq
  const cached = PREDICTION_CACHE.get(sessionId)
  if (cached !== undefined && cached.seq === seq) {
    diag.cached = true
    return cached.text
  }

  const messages = agent.session.deriveMessages()
  diag.messages = messages.length
  const transcript = transcriptOf(messages)
  diag.transcript = transcript.length
  if (transcript === '') return null

  const route = routeOf(ctx, agent)
  diag.route = route === null ? 'none' : `${route.provider}/${route.model}`
  if (route === null) return null

  const effort = await pickEffort(ctx, route)
  diag.effort = effort ?? 'default'

  const budget = deadline(signal, LLM_TIMEOUT_MS)
  let raw = ''
  let blockText = ''
  let finishKind
  let sent = ''
  diag.finish = 'none'

  const publish = (value) => {
    if (value === '' || value === sent) return
    sent = value
    emit({ type: 'text', text: value })
  }

  try {
    const stream = ctx.llm.stream({
      provider: route.provider,
      model: route.model,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [{ type: 'text', text: transcript }] }],
      maxTokens: 160,
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
      signal: budget.signal,
    })
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') {
        raw += chunk.text
        publish(previewOf(raw))
      } else if (chunk.type === 'block-end' && chunk.block?.type === 'text') {
        blockText = chunk.block.text
      } else if (chunk.type === 'finish') {
        finishKind = chunk.reason.kind
        break
      }
    }
    // Some routes settle the whole block without emitting deltas.
    if (raw === '' && blockText !== '') {
      raw = blockText
      publish(previewOf(raw))
    }
  } catch (error) {
    diag.error = String(error?.message ?? error)
    // Keep whatever streamed before the failure; the final clean decides.
  } finally {
    budget.cancel()
  }

  diag.finish = finishKind ?? 'none'
  diag.raw = raw.length
  diag.head = raw.slice(0, 120)
  // A cancelled stream is not a prediction: never cache its partial text.
  if (signal.aborted || finishKind === 'aborted' || finishKind === 'error') {
    PREDICTION_CACHE.set(sessionId, { seq, text: null })
    return null
  }

  const text = finalize(raw)
  PREDICTION_CACHE.set(sessionId, { seq, text })
  return text
}

/** Assistant-voice openers that must never reach the input, even briefly. */
const OPENERS = ['sure', 'of course', "i'll", 'i will', 'i can', 'let me', "here's", '当然', '好的', '没问题']

/** Text that is safe to paint while the reply is still arriving. */
function previewOf(raw) {
  let text = String(raw).replace(/^\s+/, '')
  if (text === '') return ''
  // Hold back while the reply could still turn out to be the SKIP sentinel.
  const head = text.slice(0, 4).toLowerCase()
  if (text.length < 4 && 'skip'.startsWith(head)) return ''
  if (/^skip\b/i.test(text)) return ''
  text = text.replace(/^["'“”‘’]+/, '')
  text = text.replace(/\s+/g, ' ')
  // Suppress assistant-voice openings, including partial ones, before they paint.
  const lower = text.toLowerCase()
  for (const opener of OPENERS) {
    if (lower.startsWith(opener) || (lower.length < opener.length && opener.startsWith(lower))) return ''
  }
  if (text.length > MAX_SUGGESTION_CHARS) text = `${text.slice(0, MAX_SUGGESTION_CHARS)}…`
  return text.trim()
}

/** Final value: SKIP and unusable replies become null. */
function finalize(raw) {
  const source = String(raw ?? '').trim()
  if (source === '' || /^skip$/i.test(source)) return null
  return extractSuggestion(source)
}

/** The exact provider/model route this Session uses, or null when unknown. */
function routeOf(ctx, agent) {
  const fallback = ctx.get('agentDefaultModel')?.currentSelection?.()
  const provider = agent.options?.provider ?? fallback?.provider
  const model = agent.options?.model ?? fallback?.model
  return provider !== undefined && model !== undefined ? { provider, model } : null
}

/** Compact `User:` / `Assistant:` transcript, newest turns kept, text only. */
function transcriptOf(messages) {
  const picked = []
  for (const message of messages) {
    const role = message.role === 'user' ? 'User' : message.role === 'assistant' ? 'Assistant' : null
    if (role === null) continue
    const text = textOf(message)
    if (text === '') continue
    picked.push(`${role}: ${text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}…` : text}`)
  }

  const lines = []
  let budget = MAX_TRANSCRIPT_CHARS
  for (let index = picked.length - 1; index >= 0; index -= 1) {
    const line = picked[index]
    if (line.length > budget) break
    budget -= line.length
    lines.unshift(line)
  }
  return lines.join('\n\n')
}

function textOf(message) {
  if (!Array.isArray(message.content)) return ''
  const parts = []
  for (const block of message.content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
      parts.push(block.text.trim())
    }
  }
  return parts.join('\n')
}

/** Turn a model reply into editable prompt text, or null when it is unusable. */
function extractSuggestion(raw) {
  const source = String(raw ?? '').trim()
  if (source === '') return null

  const start = source.indexOf('{')
  const end = source.lastIndexOf('}')
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(source.slice(start, end + 1))
      if (parsed !== null && typeof parsed === 'object' && Object.hasOwn(parsed, 'suggestion')) {
        if (parsed.suggestion === null) return null
        if (typeof parsed.suggestion === 'string') return cleanText(parsed.suggestion)
      }
    } catch {
      // Fall through: the plain-text contract is the common path.
    }
  }
  if (source.startsWith('{')) return null
  return cleanText(source)
}

function cleanText(value) {
  let text = String(value).replace(/\s+/g, ' ').trim()
  text = text.replace(/^```[a-z]*\s*/i, '').replace(/```$/, '').trim()
  text = text.replace(/^["'“”‘’]+/, '').replace(/["'“”‘’]+$/, '').trim()
  text = text.replace(/^(user|用户)\s*[:：]\s*/i, '').trim()
  if (text === '') return null
  // A leading slash would collide with the slash-command menu.
  if (text.startsWith('/')) return null
  // Reject assistant-voice openers: the suggestion must read as the user.
  if (/^(sure|of course|i'll|i will|i can|let me|here'?s|当然|好的|没问题)[\s,，:：]/i.test(text)) return null
  if (text.length > MAX_SUGGESTION_CHARS) {
    const cut = text.slice(0, MAX_SUGGESTION_CHARS)
    const space = cut.lastIndexOf(' ')
    text = `${(space > 40 ? cut.slice(0, space) : cut).trim()}…`
  }
  if (text.length < 2) return null
  return text
}

function deadline(signal, ms) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('next-prompt: timeout')), ms)
  const forward = () => controller.abort(signal.reason)
  if (signal.aborted) forward()
  else signal.addEventListener('abort', forward, { once: true })
  return {
    signal: controller.signal,
    cancel() {
      clearTimeout(timer)
      signal.removeEventListener('abort', forward)
    },
  }
}

/** Stream one prediction as Server-Sent Events, then close the response. */
function sse(run) {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream({
    async start(controller) {
      let closed = false
      const emit = (event) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
        } catch {
          closed = true
        }
      }
      let text = null
      try {
        text = await run(emit)
      } finally {
        emit({ type: 'done', text: text ?? null })
        closed = true
        try {
          controller.close()
        } catch {
          // The client may have disconnected first.
        }
      }
    },
  }), {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
    },
  })
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  })
}
