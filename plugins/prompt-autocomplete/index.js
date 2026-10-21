/**
 * Host half of the prompt-autocomplete bundle.
 *
 * One authenticated exact Fetch route below `/api` streams the continuation of
 * the message the user is currently typing. Context: the last few conversation
 * messages, the workspace root, and any `@`-referenced files in the draft.
 */

import { appendFileSync } from 'node:fs'

const ENDPOINT = '/api/prompt-autocomplete/complete'
const MAX_TRANSCRIPT_CHARS = 640
const MAX_MESSAGE_CHARS = 260
const MAX_DRAFT_CHARS = 2000
const MAX_FILE_CHARS = 1200
const MAX_FILES = 2
const MAX_LIST_ENTRIES = 10
const MAX_COMPLETION_CHARS = 40
const LLM_TIMEOUT_MS = 9000
const CACHE_LIMIT = 120

/** `${sessionId}|${seq}|${draft}` -> completion text (or null). */
const CACHE = new Map()
const EFFORT_CACHE = new Map()

const SYSTEM_PROMPT = [
  'Continue the sentence the user is typing. Append to the draft, one grammatical sentence, at most 20 characters.',
  'Never repeat the draft, start a new sentence, answer the draft, or add quotes/markdown. Same language. If the draft is already complete or no continuation is obvious, output SKIP.',
  'Example: Draft: 帮我把登录页的错误提示 / Continuation: 改得更具体一点，按错误码区分',
  'Example: Draft: 今天的会开完了 / Continuation: SKIP',
].join('\n')

export const inject = ['llm', 'agents', 'connection']

function logDebug(line) {
  try {
    appendFileSync('/tmp/pa-debug.log', `${new Date().toISOString()} ${line}\n`)
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

export function apply(ctx) {
  ctx.effect(() => ctx.connection.fetch.register({
    path: ENDPOINT,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: (request) => handleRequest(ctx, request),
  }))

  // Temporary client-side trace sink used while diagnosing the trigger path.
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/prompt-autocomplete/trace',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        logDebug(`trace ${JSON.stringify(await request.json())}`)
      } catch {
        // A malformed trace is not worth reporting.
      }
      return new Response(null, { status: 204 })
    },
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
  const draft = payload && typeof payload.draft === 'string' ? payload.draft : ''
  if (!sessionId || draft.trim() === '') return json({ text: null }, 400)

  const started = Date.now()
  const diag = { draft: draft.length }
  if (typeof payload.reason === 'string') diag.reason = payload.reason

  return sse(async (emit) => {
    let text = null
    try {
      text = await complete(ctx, sessionId, draft, request.signal, emit, diag)
    } catch (error) {
      diag.error = String(error?.message ?? error)
    } finally {
      diag.ms = Date.now() - started
      diag.text = text
      logDebug(`complete ${JSON.stringify(diag)}`)
    }
    return text
  })
}

/** Generate one continuation, emitting incremental text as it arrives. */
async function complete(ctx, sessionId, rawDraft, signal, emit, diag) {
  const draft = rawDraft.slice(-MAX_DRAFT_CHARS)
  // A finished thought is not a completion target.
  if (/[。！？.!?]\s*$/.test(draft)) return null
  const agent = ctx.agents.get(sessionId)
  diag.agent = agent !== undefined
  if (agent === undefined) return null

  const seq = agent.session.seq
  const cacheKey = `${sessionId}|${seq}|${draft}`
  if (CACHE.has(cacheKey)) {
    diag.cached = true
    return CACHE.get(cacheKey)
  }

  const messages = agent.session.deriveMessages()
  const transcript = transcriptOf(messages)
  diag.transcript = transcript.length

  const route = routeOf(ctx, agent)
  diag.route = route === null ? 'none' : `${route.provider}/${route.model}`
  if (route === null) return null

  const context = await contextOf(ctx, agent, draft)
  diag.files = context.files
  diag.listing = context.listing

  const effort = await pickEffort(ctx, route)
  diag.effort = effort ?? 'default'

  const prompt = renderPrompt({ transcript, workspace: context.workspace, files: context.filesText, draft })
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
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      maxTokens: 64,
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
      signal: budget.signal,
    })
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') {
        raw += chunk.text
        publish(previewOf(raw, draft))
      } else if (chunk.type === 'block-end' && chunk.block?.type === 'text') {
        blockText = chunk.block.text
      } else if (chunk.type === 'finish') {
        finishKind = chunk.reason.kind
        break
      }
    }
    if (raw === '' && blockText !== '') {
      raw = blockText
      publish(previewOf(raw, draft))
    }
  } catch (error) {
    diag.error = String(error?.message ?? error)
  } finally {
    budget.cancel()
  }

  diag.finish = finishKind ?? 'none'
  diag.raw = raw.length
  if (signal.aborted || finishKind === 'aborted' || finishKind === 'error') return null

  const text = finalize(raw, draft)
  remember(cacheKey, text)
  return text
}

function remember(key, text) {
  if (CACHE.size >= CACHE_LIMIT) {
    const oldest = CACHE.keys().next()
    if (!oldest.done) CACHE.delete(oldest.value)
  }
  CACHE.set(key, text)
}

/** Text that is safe to paint while the reply is still arriving. */
function previewOf(raw, draft) {
  let text = String(raw).replace(/^\s+/, '')
  if (text === '') return ''
  // While the model is still echoing what the user typed, paint nothing.
  if (draft.startsWith(text)) return ''
  const tail = draft.trim().slice(-12)
  if (tail.length >= 6 && tail.startsWith(text)) return ''
  if (text.startsWith(draft)) text = text.slice(draft.length)
  else if (tail.length >= 6 && text.startsWith(tail)) text = text.slice(tail.length)
  if (text.length < 4 && 'skip'.startsWith(text.toLowerCase())) return ''
  if (/^skip\b/i.test(text)) return ''
  text = text.replace(/\s+/g, ' ')
  if (text.length > MAX_COMPLETION_CHARS) text = text.slice(0, MAX_COMPLETION_CHARS)
  return text.trim()
}

/** Final continuation, cleaned of repetition, quotes, and unusable replies. */
function finalize(raw, draft) {
  let text = String(raw ?? '').trim()
  if (text === '' || /^skip$/i.test(text)) return null
  text = text.replace(/^```[a-z]*\s*/i, '').replace(/```$/, '').trim()
  text = text.replace(/^["'“”‘’]+/, '').replace(/["'“”‘’]+$/, '').trim()
  text = text.replace(/\s+/g, ' ')
  // Some models restart the message instead of continuing it.
  if (text.startsWith(draft)) text = text.slice(draft.length).trim()
  const tail = draft.trim().slice(-12)
  if (tail.length >= 6 && text.startsWith(tail)) text = text.slice(tail.length).trim()
  if (text === '' || text === draft) return null
  if (text.length > MAX_COMPLETION_CHARS) {
    const cut = text.slice(0, MAX_COMPLETION_CHARS)
    const space = cut.lastIndexOf(' ')
    text = (space > 12 ? cut.slice(0, space) : cut).trim()
  }
  return text.length < 1 ? null : text
}

/** The exact provider/model route this Session uses, or null when unknown. */
function routeOf(ctx, agent) {
  const fallback = ctx.get('agentDefaultModel')?.currentSelection?.()
  const provider = agent.options?.provider ?? fallback?.provider
  const model = agent.options?.model ?? fallback?.model
  return provider !== undefined && model !== undefined ? { provider, model } : null
}

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

/** Workspace listing plus up to three `@`-referenced files from the draft. */
async function contextOf(ctx, agent, draft) {
  const fs = ctx.get('fs')
  const out = { workspace: '', files: 0, listing: 0, filesText: '' }
  if (fs === undefined) return out

  let cwd
  try {
    cwd = ctx.get('workingDirectory')?.get(agent.session)
  } catch {
    cwd = undefined
  }

  const parts = []
  if (cwd !== undefined) {
    out.workspace = cwd
    try {
      const root = await fs.resolve(cwd)
      const entries = await fs.listDir(root)
      const names = entries
        .filter((entry) => !entry.name.startsWith('.'))
        .slice(0, MAX_LIST_ENTRIES)
        .map((entry) => (entry.type === 'directory' ? `${entry.name}/` : entry.name))
      if (names.length > 0) {
        out.listing = names.length
        parts.push(`Workspace: ${cwd}\nTop level: ${names.join(', ')}`)
      }
    } catch {
      // Listing is best-effort.
    }
  }

  const paths = [...String(draft).matchAll(/@([^\s@，。；、,;]+)/g)].map((match) => match[1])
  const unique = [...new Set(paths)].slice(0, MAX_FILES)
  const fileParts = []
  for (const path of unique) {
    try {
      const target = await fs.resolve(path, cwd === undefined ? undefined : { cwd })
      const info = await fs.stat(target)
      if (info === undefined || info.type !== 'file' || (info.size ?? 0) > 400_000) continue
      const text = await fs.readText(target)
      out.files += 1
      fileParts.push(`### ${path}\n${text.slice(0, MAX_FILE_CHARS)}`)
    } catch {
      // Missing or unreadable references are simply skipped.
    }
  }
  out.filesText = fileParts.join('\n\n')
  return { ...out, workspace: parts.join('\n') + (fileParts.length > 0 ? `\n\nReferenced files:\n${out.filesText}` : '') }
}

function renderPrompt({ transcript, workspace, files, draft }) {
  return [
    '[Conversation]',
    transcript,
    '',
    workspace === '' ? '' : '[Workspace]',
    workspace,
    '',
    files === '' ? '' : files,
    '[Draft so far — continue from the end]',
    draft,
  ].filter((line) => line !== '').join('\n')
}

function deadline(signal, ms) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('prompt-autocomplete: timeout')), ms)
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

/** Stream one completion as Server-Sent Events, then close the response. */
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
