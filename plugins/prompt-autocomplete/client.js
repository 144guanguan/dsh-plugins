window.__ModuleLoader__.load({
  id: 'dsh-prompt-autocomplete',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const DEBUG = (() => {
      try {
        return new URLSearchParams(window.location.search).has('padebug')
      } catch {
        return false
      }
    })()

    const CSS = `
      .dsh-pa {
        position: absolute;
        z-index: 6;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
        pointer-events: none;
        color: var(--dsw-alias-label-caption);
        opacity: 0.82;
      }
    `

    const MIN_DRAFT = 2
    const PAUSE_MS = 120

    function composerCard() {
      return document.querySelector('[data-conversation-region="composer"] [data-composer-card]')
    }

    function editorOf(card) {
      return card === null ? null : card.querySelector('[contenteditable="true"]')
    }

    function caretRect(editor, range) {
      let rect = range.getBoundingClientRect()
      if (rect.width > 0 || rect.height > 0) return rect
      const node = range.endContainer
      const offset = range.endOffset
      if (node.nodeType === Node.TEXT_NODE && offset > 0) {
        const probe = range.cloneRange()
        probe.setStart(node, offset - 1)
        probe.setEnd(node, offset)
        const rects = probe.getClientRects()
        if (rects.length > 0) {
          const last = rects[rects.length - 1]
          return { left: last.right, right: last.right, top: last.top, bottom: last.bottom, width: 0, height: last.height }
        }
      }
      return editor.getBoundingClientRect()
    }

    /**
     * Whether the caret is at the end of the draft. Two independent checks, so a
     * Lexical trailing break or zero-width node cannot block every request.
     */
    function isAtEnd(editor, range) {
      const before = range.cloneRange()
      before.selectNodeContents(editor)
      try {
        before.setEnd(range.endContainer, range.endOffset)
      } catch {
        return false
      }
      if (before.toString().length >= (editor.textContent ?? '').length) return true
      const after = range.cloneRange()
      after.selectNodeContents(editor)
      try {
        after.setStart(range.endContainer, range.endOffset)
      } catch {
        return false
      }
      const fragment = after.cloneContents()
      if (fragment.textContent.replace(/[\s\u200b\ufeff]/g, '') !== '') return false
      return fragment.querySelector('br, img, [data-lexical-decorator]') === null
    }

    /** Caret rect plus the glyph box of the character before it. */
    function caretInfo(editor) {
      const selection = window.getSelection()
      if (selection === null || selection.rangeCount === 0) return null
      const range = selection.getRangeAt(0)
      if (!range.collapsed) return null
      if (!editor.contains(range.endContainer)) return null
      let glyph = null
      const node = range.endContainer
      const offset = range.endOffset
      if (node.nodeType === Node.TEXT_NODE && offset > 0) {
        const probe = range.cloneRange()
        probe.setStart(node, offset - 1)
        probe.setEnd(node, offset)
        glyph = probe.getBoundingClientRect()
      }
      return { rect: caretRect(editor, range), glyph, atEnd: isAtEnd(editor, range) }
    }

    function boxOf(el, card, editor, rect) {
      const cardRect = card.getBoundingClientRect()
      const base = (el?.offsetParent ?? card).getBoundingClientRect()
      const style = getComputedStyle(editor)
      const left = rect.left - base.left
      const width = cardRect.right - 8 - rect.left
      if (width < 48) return null
      return {
        left,
        top: rect.top - base.top,
        width,
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        lineHeight: style.lineHeight,
        letterSpacing: style.letterSpacing,
      }
    }

    function joinSpace(draft, text) {
      if (/[A-Za-z0-9]$/.test(draft) && /^[A-Za-z0-9]/.test(text)) return ` ${text}`
      return text
    }

    function PromptAutocomplete(props) {
      const { inputActions, sessionId } = props
      const useInput = props.useInput
      const useSession = props.useSession

      const draft = useInput((state) => state.draft)
      const draftRev = useInput((state) => state.draftRev)
      const running = useSession((state) => state.running)

      const [ghost, setGhost] = React.useState(null)
      const [box, setBox] = React.useState(null)
      const ghostRef = React.useRef(null)

      const draftRef = React.useRef(draft)
      draftRef.current = draft
      const draftRevRef = React.useRef(draftRev)
      draftRevRef.current = draftRev
      const runningRef = React.useRef(running)
      runningRef.current = running
      const sessionRef = React.useRef(sessionId)
      sessionRef.current = sessionId
      const abortRef = React.useRef(null)
      const lastCompositionAtRef = React.useRef(0)
      const serialRef = React.useRef(0)
      // Accepting inserts text, which is also a draft change: skip one trigger.
      const skipNextRef = React.useRef(false)
      // One measured correction per request: offsets the systematic placement
      // error of the overlay containing block.
      const offsetRef = React.useRef({ serial: -1, dx: 0, dy: 0 })
      const lastDraftAtRef = React.useRef(Date.now())
      const lastAttemptRef = React.useRef({ at: 0, draft: '' })

      // Switching Sessions or typing invalidates the continuation immediately.
      React.useEffect(() => {
        setGhost(null)
        abortRef.current?.abort()
        abortRef.current = null
      }, [sessionId])

      React.useEffect(() => {
        lastDraftAtRef.current = Date.now()
        // Detach instead of aborting: an IME can touch the draft mid-request,
        // and the revision guard already discards a stale answer.
        abortRef.current = null
        setGhost(null)
      }, [draft])

      const trace = React.useCallback((event, extra) => {
        if (!DEBUG) return
        try {
          void fetch('/api/prompt-autocomplete/trace', {
            method: 'POST',
            credentials: 'same-origin',
            keepalive: true,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: sessionRef.current, event, ...extra }),
          })
        } catch {
          // Diagnostics only.
        }
      }, [])

      const request = React.useCallback(async (reason) => {
        trace('enter', { reason })
        const skip = (why) => {
          const card = composerCard()
          const editor = editorOf(card)
          trace('skip', {
            why,
            len: draftRef.current.length,
            focused: editor !== null && document.activeElement === editor,
            menu: document.querySelector('[data-trigger-menu]') !== null,
          })
          if (DEBUG) console.info('[prompt-autocomplete] skip', why, draftRef.current.length)
          return
        }
        if (abortRef.current !== null) return skip('inflight')
        if (runningRef.current) return skip('running')
        const snapshot = draftRef.current
        if (snapshot.trim().length < MIN_DRAFT) return skip('short')

        const card = composerCard()
        const editor = editorOf(card)
        if (card === null || editor === null) return skip('no-editor')
        if (document.activeElement !== editor) return skip('not-focused')
        if (document.querySelector('[data-trigger-menu]') !== null) return skip('menu')

        const info = caretInfo(editor)
        if (info === null) return skip('no-caret')
        if (!info.atEnd) trace('caret', { atEnd: false, len: snapshot.length })

        lastAttemptRef.current = { at: Date.now(), draft: snapshot }
        trace('attempt', { len: snapshot.length, reason })
        const controller = new AbortController()
        abortRef.current = controller
        const target = sessionRef.current
        const serial = ++serialRef.current

        const publish = (text) => {
          const value = text.trim()
          if (value === '') return
          if (serialRef.current !== serial) return
          if (abortRef.current !== controller) return
          if (sessionRef.current !== target) return
          if (draftRef.current !== snapshot) return
          if (runningRef.current) return
          setGhost({ text: value })
        }

        try {
          const response = await fetch('/api/prompt-autocomplete/complete', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: target, draft: snapshot, reason }),
            signal: controller.signal,
          })
          trace('http', { status: response.status, body: response.body !== null })
          if (!response.ok || response.body === null) return
          const reader = response.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            let cut
            while ((cut = buffer.indexOf('\n\n')) !== -1) {
              const frame = buffer.slice(0, cut)
              buffer = buffer.slice(cut + 2)
              if (!frame.startsWith('data: ')) continue
              let event
              try {
                event = JSON.parse(frame.slice(6))
              } catch {
                continue
              }
              if (event.type === 'text' && typeof event.text === 'string') {
                publish(event.text)
              } else if (event.type === 'done') {
                if (typeof event.text === 'string' && event.text.trim() !== '') publish(event.text)
                else setGhost(null)
                trace('done', { len: typeof event.text === 'string' ? event.text.length : 0 })
                if (DEBUG) console.info('[prompt-autocomplete]', reason, 'done', event.text)
              }
            }
          }
        } catch (error) {
          if (error?.name === 'AbortError') {
            lastAttemptRef.current = { at: 0, draft: '' }
            trace('aborted', { len: snapshot.length })
          } else if (DEBUG) {
            console.info('[prompt-autocomplete] failed', error)
          }
        } finally {
          if (abortRef.current === controller) abortRef.current = null
        }
      }, [])

      // Re-measure on every text frame: the caret may move because the layout
      // changed while the request was in flight.
      React.useLayoutEffect(() => {
        if (ghost === null) {
          setBox(null)
          return undefined
        }
        let disposed = false
        const measure = () => {
          if (disposed) return
          const card = composerCard()
          const editor = editorOf(card)
          if (card === null || editor === null) {
            setGhost(null)
            return
          }
          const info = caretInfo(editor)
          if (info === null || !info.atEnd) {
            setGhost(null)
            return
          }
          const next = boxOf(ghostRef.current, card, editor, info.rect)
          if (next === null) {
            setGhost(null)
            return
          }
          const offset = offsetRef.current
          if (offset.serial === serialRef.current) {
            next.left += offset.dx
            next.top += offset.dy
          }
          setBox(next)
          // After the box is painted, compare the real rect with the caret and
          // remember the delta for every later frame of this suggestion.
          requestAnimationFrame(() => {
            if (offsetRef.current.serial === serialRef.current) return
            const el = ghostRef.current
            const cardNow = composerCard()
            const editorNow = editorOf(cardNow)
            if (el === null || editorNow === null) return
            const infoNow = caretInfo(editorNow)
            if (infoNow === null) return
            const rect = el.getBoundingClientRect()
            const dx = infoNow.rect.left - rect.left
            // Align glyph boxes, not line boxes: half-leading differs between
            // the editor's line and an absolutely positioned ghost line.
            let dy = infoNow.rect.top - rect.top
            const textNode = el.lastChild
            if (infoNow.glyph !== null && textNode !== null && textNode.nodeType === Node.TEXT_NODE) {
              const glyphRange = document.createRange()
              glyphRange.selectNodeContents(textNode)
              const glyphRect = glyphRange.getClientRects()[0]
              if (glyphRect !== undefined) dy = infoNow.glyph.top - glyphRect.top
            }
            offsetRef.current = { serial: serialRef.current, dx, dy }
            trace('calibrate', {
              dx: Math.round(dx * 10) / 10,
              dy: Math.round(dy * 10) / 10,
              caretTop: Math.round(infoNow.rect.top),
              glyphTop: infoNow.glyph === null ? -1 : Math.round(infoNow.glyph.top),
              boxTop: Math.round(rect.top),
              caretLeft: Math.round(infoNow.rect.left),
              boxLeft: Math.round(rect.left),
            })
            if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
              setBox((current) => (current === null ? current : { ...current, left: current.left + dx, top: current.top + dy }))
            }
          })
          if (DEBUG) console.info('[prompt-autocomplete] box', next, 'base', (ghostRef.current?.offsetParent ?? card).getBoundingClientRect().toJSON?.() ?? '')
        }
        measure()
        window.addEventListener('resize', measure)
        window.addEventListener('scroll', measure, true)
        const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
        observer?.observe(composerCard() ?? document.body)
        return () => {
          disposed = true
          window.removeEventListener('resize', measure)
          window.removeEventListener('scroll', measure, true)
          observer?.disconnect()
        }
      }, [ghost])

      // One request per typing pause; every keystroke cancels the pending one.
      React.useEffect(() => {
        if (skipNextRef.current) {
          skipNextRef.current = false
          trace('skip', { why: 'post-accept', len: draft.trim().length })
          return undefined
        }
        if (running) return undefined
        if (draft.trim().length < MIN_DRAFT) return undefined
        trace('schedule', { len: draft.trim().length })
        const timer = setTimeout(() => {
          trace('fire', { len: draftRef.current.length })
          request('pause').catch((error) => trace('reject', { m: String(error?.message ?? error) }))
        }, PAUSE_MS)
        return () => clearTimeout(timer)
      }, [draft, running, request, trace])

      // Safety net: if a debounce timer is lost (throttling, remount), a draft
      // that has been untouched for a while still gets one prediction.
      React.useEffect(() => {
        trace('watchdog-mount')
        const timer = setInterval(() => {
          const idle = Date.now() - lastDraftAtRef.current
          if (idle < 900) return
          const card = composerCard()
          const editor = editorOf(card)
          trace('watchdog-idle', {
            idle,
            len: draftRef.current.length,
            ghost: ghost !== null,
            inflight: abortRef.current !== null,
            focused: editor !== null && document.activeElement === editor,
          })
          if (ghost !== null || abortRef.current !== null) return
          if (editor === null || document.activeElement !== editor) return
          if (draftRef.current.trim().length < MIN_DRAFT) return
          const last = lastAttemptRef.current
          if (last.draft === draftRef.current && Date.now() - last.at < 1500) return
          trace('watchdog', { len: draftRef.current.length })
          request('watchdog').catch((error) => trace('reject', { m: String(error?.message ?? error) }))
        }, 700)
        return () => clearInterval(timer)
      }, [ghost, request, trace])

      // Never predict while an IME composition is open.
      React.useEffect(() => {
        const onStart = () => {
          lastCompositionAtRef.current = Date.now()
          setGhost(null)
        }
        const onEnd = () => {
          lastCompositionAtRef.current = Date.now()
        }
        const onUpdate = () => {
          lastCompositionAtRef.current = Date.now()
        }
        const onInput = (event) => {
          if (event.isComposing === true) lastCompositionAtRef.current = Date.now()
        }
        document.addEventListener('compositionstart', onStart, true)
        document.addEventListener('compositionend', onEnd, true)
        document.addEventListener('compositionupdate', onUpdate, true)
        document.addEventListener('input', onInput, true)
        return () => {
          document.removeEventListener('compositionstart', onStart, true)
          document.removeEventListener('compositionend', onEnd, true)
          document.removeEventListener('compositionupdate', onUpdate, true)
          document.removeEventListener('input', onInput, true)
        }
      }, [])

      // Moving the caret or losing the editor dismisses the continuation.
      React.useEffect(() => {
        if (ghost === null) return undefined
        const onSelectionChange = () => {
          setGhost(null)
          abortRef.current?.abort()
          abortRef.current = null
        }
        document.addEventListener('selectionchange', onSelectionChange)
        return () => document.removeEventListener('selectionchange', onSelectionChange)
      }, [ghost])

      // Leaving the editor dismisses the continuation too.
      React.useEffect(() => {
        if (ghost === null) return undefined
        const onFocusOut = (event) => {
          const card = composerCard()
          const editor = editorOf(card)
          if (editor === null || event.target !== editor) return
          setGhost(null)
          abortRef.current?.abort()
          abortRef.current = null
        }
        document.addEventListener('focusout', onFocusOut, true)
        return () => document.removeEventListener('focusout', onFocusOut, true)
      }, [ghost])

      // Tab accepts the whole continuation at the caret; Escape dismisses.
      React.useEffect(() => {
        if (ghost === null) return undefined
        const onKeyDown = (event) => {
          const card = composerCard()
          const editor = editorOf(card)
          if (editor === null || document.activeElement !== editor) return
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            setGhost(null)
            abortRef.current?.abort()
            abortRef.current = null
            return
          }
          if (event.key !== 'Tab' || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return
          if (event.isComposing) return
          event.preventDefault()
          event.stopPropagation()
          const span = inputActions.captureInsertion()
          const text = joinSpace(draftRef.current, ghost.text)
          skipNextRef.current = true
          setGhost(null)
          inputActions.insertText(text, span)
        }
        window.addEventListener('keydown', onKeyDown, true)
        return () => window.removeEventListener('keydown', onKeyDown, true)
      }, [ghost, inputActions])

      if (ghost === null) return null

      return h('div', {
        ref: ghostRef,
        className: 'dsh-pa',
        'data-prompt-autocomplete': '',
        'aria-hidden': true,
        style: box === null ? { visibility: 'hidden' } : {
          left: `${box.left}px`,
          top: `${box.top}px`,
          width: `${box.width}px`,
          fontFamily: box.fontFamily,
          fontSize: box.fontSize,
          fontWeight: box.fontWeight,
          lineHeight: box.lineHeight,
          letterSpacing: box.letterSpacing,
        },
      }, [
        h('style', { key: 'style' }, CSS),
        ghost.text,
      ])
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
          name: 'conversation.input.overlay',
          id: 'prompt-autocomplete',
        }, PromptAutocomplete))
      },
    }
  },
})
