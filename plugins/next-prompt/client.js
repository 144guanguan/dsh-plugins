window.__ModuleLoader__.load({
  id: 'dsh-next-prompt',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const DEBUG = (() => {
      try {
        return new URLSearchParams(window.location.search).has('npdebug')
      } catch {
        return false
      }
    })()

    const CSS = `
      .dsh-np-ghost {
        position: absolute;
        z-index: 6;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
        pointer-events: none;
        color: var(--dsw-alias-label-caption);
        opacity: 0.9;
      }
      [data-next-prompt-ghost] [data-composer-placeholder] {
        visibility: hidden !important;
      }
    `

    /**
     * The suggestion is painted as ghost text exactly where the composer's own
     * placeholder sits: measure that node inside the same composer card, hide
     * it while the ghost is mounted, and reuse its font metrics. Text arrives
     * progressively from the Host's SSE stream, so the first words show early.
     */
    function NextPromptGhost(props) {
      const { inputActions, sessionId } = props
      const useInput = props.useInput
      const useSession = props.useSession

      const draft = useInput((state) => state.draft)
      const running = useSession((state) => state.running)
      const blank = useSession((state) => state.blank)
      const awaitingFirstTurn = useSession((state) => state.awaitingFirstTurn)
      const lastAgentError = useSession((state) => state.lastAgentError)

      const [suggestion, setSuggestion] = React.useState(null)
      const suggestionRef = React.useRef(null)
      suggestionRef.current = suggestion
      const shown = suggestion !== null

      const [box, setBox] = React.useState(null)
      const ghostRef = React.useRef(null)

      const draftRef = React.useRef(draft)
      draftRef.current = draft
      const runningRef = React.useRef(running)
      runningRef.current = running
      const sessionRef = React.useRef(sessionId)
      sessionRef.current = sessionId
      const abortRef = React.useRef(null)
      const previousRunning = React.useRef(running)
      const primedRef = React.useRef(false)

      // Switching Sessions drops the old suggestion and its in-flight request.
      React.useEffect(() => {
        setSuggestion(null)
        abortRef.current?.abort()
        abortRef.current = null
        previousRunning.current = runningRef.current
        primedRef.current = false
      }, [sessionId])

      // Any typing permanently dismisses the suggestion, matching the products.
      React.useEffect(() => {
        if (draft.trim() === '') return
        setSuggestion(null)
        abortRef.current?.abort()
        abortRef.current = null
      }, [draft])

      const request = React.useCallback(async (reason) => {
        // One in-flight prediction per composer: mount and turn-end can race.
        if (abortRef.current !== null) return
        const target = sessionRef.current
        const controller = new AbortController()
        abortRef.current = controller

        // Every frame is ignored unless this composer is still the one waiting.
        const publish = (text) => {
          if (text === '' || text.trim() === '') return
          if (sessionRef.current !== target || runningRef.current || draftRef.current.trim() !== '') return
          setSuggestion({ text })
        }

        try {
          const response = await fetch('/api/next-prompt/suggest', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: target, debug: DEBUG, reason }),
            signal: controller.signal,
          })
          if (!response.ok || response.body === null) {
            if (DEBUG) console.info('[next-prompt]', reason, response.status)
            return
          }
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
                else setSuggestion(null)
                if (DEBUG) console.info('[next-prompt]', reason, 'done', event.text)
              }
            }
          }
        } catch (error) {
          if (error?.name !== 'AbortError' && DEBUG) console.info('[next-prompt] failed', error)
        } finally {
          if (abortRef.current === controller) abortRef.current = null
        }
      }, [])

      // Generate once per completed turn, and only while the composer is empty.
      React.useEffect(() => {
        const wasRunning = previousRunning.current
        previousRunning.current = running
        if (running) {
          abortRef.current?.abort()
          abortRef.current = null
          setSuggestion(null)
          return undefined
        }
        if (!wasRunning) return undefined
        if (blank || awaitingFirstTurn || lastAgentError || draftRef.current.trim() !== '') return undefined
        const timer = setTimeout(() => { void request('turn-end') }, 80)
        return () => clearTimeout(timer)
      }, [running, blank, awaitingFirstTurn, lastAgentError, request])

      // First paint of a loaded Session: one prediction, so a refresh or a
      // switch back to an idle Session still offers a next step.
      React.useEffect(() => {
        if (primedRef.current) return undefined
        if (running || blank || awaitingFirstTurn || lastAgentError) return undefined
        if (draftRef.current.trim() !== '') return undefined
        primedRef.current = true
        const timer = setTimeout(() => { void request('mount') }, 80)
        return () => clearTimeout(timer)
      }, [sessionId, running, blank, awaitingFirstTurn, lastAgentError, request])

      const accept = React.useCallback(() => {
        const current = suggestionRef.current
        if (current === null) return
        setSuggestion(null)
        inputActions.setDraft(current.text)
      }, [inputActions])

      // Hide the native placeholder only while the ghost is painted. Measured
      // on the null → shown transition; later text updates keep the same box.
      React.useLayoutEffect(() => {
        if (!shown) return undefined
        const card = ghostRef.current?.closest('[data-composer-card]')
        if (card === null || card === undefined) return undefined
        card.setAttribute('data-next-prompt-ghost', '')
        return () => card.removeAttribute('data-next-prompt-ghost')
      }, [shown])

      // Measure the placeholder origin and font once per painted suggestion.
      React.useLayoutEffect(() => {
        if (!shown) {
          setBox(null)
          return undefined
        }
        const el = ghostRef.current
        if (el === null) return undefined
        const card = el.closest('[data-composer-card]')
        if (card === null) return undefined
        const placeholder = card.querySelector('[data-composer-placeholder]')
        const target = placeholder ?? card.querySelector('[contenteditable="true"]')
        if (target === null) return undefined

        const measure = () => {
          const cardRect = card.getBoundingClientRect()
          const rect = target.getBoundingClientRect()
          const style = getComputedStyle(target)
          const padLeft = placeholder === null ? Number.parseFloat(style.paddingLeft) || 0 : 0
          const padTop = placeholder === null ? Number.parseFloat(style.paddingTop) || 0 : 0
          setBox({
            left: rect.left - cardRect.left + padLeft,
            top: rect.top - cardRect.top + padTop,
            width: Math.max(0, rect.width - padLeft),
            fontFamily: style.fontFamily,
            fontSize: style.fontSize,
            fontWeight: style.fontWeight,
            lineHeight: style.lineHeight,
            letterSpacing: style.letterSpacing,
          })
        }

        measure()
        window.addEventListener('resize', measure)
        window.addEventListener('scroll', measure, true)
        const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
        observer?.observe(card)
        observer?.observe(target)
        return () => {
          window.removeEventListener('resize', measure)
          window.removeEventListener('scroll', measure, true)
          observer?.disconnect()
        }
      }, [shown])

      // Tab accepts only while the empty composer owns focus and no autocomplete
      // menu is open; every other Tab keeps its normal behavior.
      React.useEffect(() => {
        if (!shown) return undefined
        const onKeyDown = (event) => {
          if (event.key !== 'Tab' || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return
          if (event.repeat) return
          if (draftRef.current.trim() !== '') return
          const active = document.activeElement
          if (!(active instanceof HTMLElement)) return
          if (active.closest('[data-conversation-region="composer"]') === null) return
          event.preventDefault()
          event.stopPropagation()
          accept()
        }
        window.addEventListener('keydown', onKeyDown, true)
        return () => window.removeEventListener('keydown', onKeyDown, true)
      }, [shown, accept])

      if (!shown) return null

      return h('div', {
        ref: ghostRef,
        className: 'dsh-np-ghost',
        'data-next-prompt-ghost-entry': '',
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
        suggestion.text,
      ])
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
          name: 'conversation.input.overlay',
          id: 'next-prompt',
        }, NextPromptGhost))
      },
    }
  },
})
