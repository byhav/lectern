'use client'

import cloud from 'd3-cloud'
import { useEffect, useMemo, useRef, useState } from 'react'

// ─── Types ────────────────────────────────────────────────────────────────────

type Response = { id: string; content: string }

type FreqEntry = { count: number; display: string }

type PlacedWord = {
  phrase: string  // normalized (lowercase, stopwords stripped)
  display: string // best casing variant
  x: number
  y: number
  rotate: number
}

// ─── Constants ────────────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  'the','a','an','and','of','to','is','in','it','this','that','for',
  'on','with','are','was','at','be','as','by','from','or','but','not',
  'we','our','i','you','your','my','their','they','have','has','had',
  'will','can','do','does','did','so','if','more','all','up','out',
])

// Most-frequent → coral, teal; less-frequent → orange, green, slate
const PALETTE = ['#e76f51', '#2a9d8f', '#f4a261', '#8ab17d', '#264653']

const MAX_WORDS = 100
const RELAYOUT_PHRASE_THRESHOLD = 20
const RELAYOUT_TIME_MS = 30_000

// ─── Helpers ──────────────────────────────────────────────────────────────────

function computeWordFreq(responses: Response[]): Map<string, FreqEntry> {
  const variantCounts = new Map<string, Map<string, number>>()

  for (const r of responses) {
    const raw = r.content.trim().replace(/[^a-z0-9\s]/gi, '').trim()
    if (!raw) continue

    const lowerWords = raw.toLowerCase().split(/\s+/).filter(Boolean)
    const originalWords = raw.split(/\s+/).filter(Boolean)
    const keptIndices = lowerWords
      .map((w, i) => (STOPWORDS.has(w) ? -1 : i))
      .filter((i) => i >= 0)
    if (keptIndices.length === 0) continue

    const phrase = keptIndices.map((i) => lowerWords[i]).join(' ')
    const displayText = keptIndices.map((i) => originalWords[i]).join(' ')

    const variants = variantCounts.get(phrase) ?? new Map<string, number>()
    variantCounts.set(phrase, variants)
    variants.set(displayText, (variants.get(displayText) ?? 0) + 1)
  }

  const freq = new Map<string, FreqEntry>()
  for (const [phrase, variants] of variantCounts) {
    let totalCount = 0
    let bestDisplay = phrase
    let bestCount = 0
    for (const [display, c] of variants) {
      totalCount += c
      if (c > bestCount) { bestCount = c; bestDisplay = display }
    }
    freq.set(phrase, { count: totalCount, display: bestDisplay })
  }

  return freq
}

function phraseHash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

function pendingPosition(
  phrase: string,
  w: number,
  h: number,
): { x: number; y: number; rotate: number } {
  const hash = phraseHash(phrase)
  const angle = ((hash % 360) * Math.PI) / 180
  const x = Math.round(Math.cos(angle) * (w * 0.34))
  const y = Math.round(Math.sin(angle) * (h * 0.34))
  return { x, y, rotate: hash % 2 === 0 ? 0 : 90 }
}

function seededRng(seed: number) {
  let s = seed
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) | 0
    return (s >>> 0) / 0x100000000
  }
}

function computeFontSize(
  count: number,
  minCount: number,
  maxCount: number,
  minFont: number,
  maxFont: number,
): number {
  if (maxCount === minCount) return Math.round((minFont + maxFont) / 2)
  return Math.round(minFont + ((count - minCount) / (maxCount - minCount)) * (maxFont - minFont))
}

function computeFontWeight(count: number, maxCount: number): number {
  return count >= maxCount * 0.66 ? 600 : 400
}

function wordColor(rank: number, total: number): string {
  const idx = Math.floor((rank / Math.max(total, 1)) * PALETTE.length)
  return PALETTE[Math.min(idx, PALETTE.length - 1)]
}

// ─── Component ────────────────────────────────────────────────────────────────

export function WordCloud({
  responses,
  minFont = 14,
  maxFont = 80,
}: {
  responses: Response[]
  minFont?: number
  maxFont?: number
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [dims, setDims] = useState({ w: 0, h: 0 })

  const [placedWords, setPlacedWords] = useState<PlacedWord[]>([])
  const [pendingWords, setPendingWords] = useState<PlacedWord[]>([])
  const [fadeSet, setFadeSet] = useState(new Set<string>())

  const placedPhrasesRef = useRef(new Set<string>())
  const pendingPhrasesRef = useRef(new Set<string>())
  const prevFreqRef = useRef(new Map<string, FreqEntry>())
  const newPhrasesSinceLayoutRef = useRef(0)
  const lastLayoutTimeRef = useRef(0)
  const layoutRunningRef = useRef(false)
  const isFirstLayoutRef = useRef(true)
  const mountedRef = useRef(true)

  // ── Dimensions via ResizeObserver ──────────────────────────────────────────

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect
      setDims({ w: Math.round(width), h: Math.round(height) })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  // ── Derived frequency data ─────────────────────────────────────────────────

  const freq = useMemo(() => computeWordFreq(responses), [responses])

  const sortedPhrases = useMemo(
    () =>
      [...freq.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, MAX_WORDS)
        .map(([p]) => p),
    [freq],
  )

  const maxCount = sortedPhrases.length > 0 ? (freq.get(sortedPhrases[0])?.count ?? 1) : 1
  const minCount =
    sortedPhrases.length > 0 ? (freq.get(sortedPhrases[sortedPhrases.length - 1])?.count ?? 1) : 1

  // ── Layout trigger ─────────────────────────────────────────────────────────

  const triggerLayout = useRef((
    freqSnapshot: Map<string, FreqEntry>,
    w: number,
    h: number,
    mf: number,
    xf: number,
  ) => {
    if (layoutRunningRef.current || w === 0 || h === 0) return
    layoutRunningRef.current = true

    const entries = [...freqSnapshot.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, MAX_WORDS)

    if (entries.length === 0) { layoutRunningRef.current = false; return }

    const localMax = entries[0][1].count
    const localMin = entries[entries.length - 1][1].count

    const words = entries.map(([phrase, { count, display }]) => ({
      text: phrase,
      display,
      count,
      size: computeFontSize(count, localMin, localMax, mf, xf),
    }))

    cloud()
      .size([w, h])
      .words(words as Parameters<ReturnType<typeof cloud>['words']>[0])
      .font('system-ui, sans-serif')
      .fontSize((d) => (d as typeof words[0]).size)
      .fontWeight((d) => {
        const c = (d as typeof words[0]).count
        return c >= localMax * 0.66 ? 600 : 400
      })
      .rotate((d) => (phraseHash((d as typeof words[0]).text ?? '') % 2 === 0 ? 0 : 90))
      .padding(6)
      .random(seededRng(42))
      .on('end', (laid) => {
        if (!mountedRef.current) return

        const placed: PlacedWord[] = (laid as typeof words).map((w) => ({
          phrase: w.text ?? '',
          display: w.display ?? w.text ?? '',
          x: (w as cloud.Word).x ?? 0,
          y: (w as cloud.Word).y ?? 0,
          rotate: (w as cloud.Word).rotate ?? 0,
        }))

        const prevPlaced = placedPhrasesRef.current
        const newPhrases = placed.filter((p) => !prevPlaced.has(p.phrase)).map((p) => p.phrase)

        placedPhrasesRef.current = new Set(placed.map((p) => p.phrase))
        newPhrases.forEach((p) => pendingPhrasesRef.current.delete(p))

        setPlacedWords(placed)
        setPendingWords((pw) => pw.filter((p) => !placedPhrasesRef.current.has(p.phrase)))

        if (newPhrases.length > 0) {
          setFadeSet(new Set(newPhrases))
          setTimeout(() => { if (mountedRef.current) setFadeSet(new Set()) }, 800)
        }

        lastLayoutTimeRef.current = Date.now()
        newPhrasesSinceLayoutRef.current = 0
        layoutRunningRef.current = false
        isFirstLayoutRef.current = false
      })
      .start()
  })

  // ── Detect new phrases + trigger layout ────────────────────────────────────

  useEffect(() => {
    if (dims.w === 0 || dims.h === 0) return

    const prev = prevFreqRef.current
    prevFreqRef.current = freq

    const newPhrases: string[] = []
    for (const [phrase] of freq) {
      if (!placedPhrasesRef.current.has(phrase) && !pendingPhrasesRef.current.has(phrase)) {
        newPhrases.push(phrase)
      }
    }

    if (newPhrases.length > 0) {
      const newItems: PlacedWord[] = newPhrases.map((phrase) => ({
        phrase,
        display: freq.get(phrase)?.display ?? phrase,
        ...pendingPosition(phrase, dims.w, dims.h),
      }))
      newPhrases.forEach((p) => pendingPhrasesRef.current.add(p))
      setPendingWords((pw) => [...pw, ...newItems])
      newPhrasesSinceLayoutRef.current += newPhrases.length
    }

    const elapsed = Date.now() - lastLayoutTimeRef.current
    const shouldLayout =
      (isFirstLayoutRef.current && freq.size > 0) ||
      newPhrasesSinceLayoutRef.current >= RELAYOUT_PHRASE_THRESHOLD ||
      (elapsed >= RELAYOUT_TIME_MS && newPhrasesSinceLayoutRef.current > 0)

    if (shouldLayout) triggerLayout.current(freq, dims.w, dims.h, minFont, maxFont)

    void prev
  }, [responses, freq, dims, minFont, maxFont])

  // ── Periodic re-layout check ───────────────────────────────────────────────

  useEffect(() => {
    const id = setInterval(() => {
      if (!mountedRef.current) return
      const elapsed = Date.now() - lastLayoutTimeRef.current
      if (elapsed >= RELAYOUT_TIME_MS && newPhrasesSinceLayoutRef.current > 0) {
        triggerLayout.current(prevFreqRef.current, dims.w, dims.h, minFont, maxFont)
      }
    }, 5_000)
    return () => clearInterval(id)
  }, [dims, minFont, maxFont])

  // ── Render ─────────────────────────────────────────────────────────────────

  if (freq.size === 0) {
    return (
      <div ref={containerRef} className="w-full h-full flex items-center justify-center">
        <span
          className="font-semibold select-none"
          style={{ fontSize: Math.round(maxFont / 2), color: '#264653', opacity: 0.18 }}
        >
          Submit a word…
        </span>
      </div>
    )
  }

  return (
    <div ref={containerRef} className="w-full h-full overflow-hidden">
      {dims.w > 0 && dims.h > 0 && (
        <svg width={dims.w} height={dims.h} aria-hidden="true" style={{ display: 'block' }}>
          <g transform={`translate(${dims.w / 2},${dims.h / 2})`}>
            {placedWords.map((w) => {
              const entry = freq.get(w.phrase)
              const count = entry?.count ?? 1
              const display = entry?.display ?? w.display
              const rank = sortedPhrases.indexOf(w.phrase)
              const fontSize = computeFontSize(count, minCount, maxCount, minFont, maxFont)
              const fontWeight = computeFontWeight(count, maxCount)
              const color = wordColor(rank, sortedPhrases.length)
              return (
                <g
                  key={w.phrase}
                  transform={`translate(${w.x},${w.y}) rotate(${w.rotate})`}
                  className={fadeSet.has(w.phrase) ? 'wc-fadein' : ''}
                >
                  <text
                    textAnchor="middle"
                    dominantBaseline="central"
                    fill={color}
                    fontSize={fontSize}
                    fontWeight={fontWeight}
                    fontFamily="system-ui, sans-serif"
                    style={{ transition: 'font-size 0.4s ease', cursor: 'default', userSelect: 'none' }}
                  >
                    {display}
                  </text>
                </g>
              )
            })}

            {pendingWords.map((w) => {
              const entry = freq.get(w.phrase)
              const count = entry?.count ?? 1
              const display = entry?.display ?? w.display
              const rank = sortedPhrases.indexOf(w.phrase)
              const fontSize = computeFontSize(count, minCount, maxCount, minFont, maxFont)
              const fontWeight = computeFontWeight(count, maxCount)
              const color = wordColor(rank, sortedPhrases.length)
              return (
                <g
                  key={w.phrase}
                  transform={`translate(${w.x},${w.y}) rotate(${w.rotate})`}
                  className="wc-popin"
                >
                  <text
                    textAnchor="middle"
                    dominantBaseline="central"
                    fill={color}
                    fontSize={fontSize}
                    fontWeight={fontWeight}
                    fontFamily="system-ui, sans-serif"
                    style={{ transition: 'font-size 0.4s ease', cursor: 'default', userSelect: 'none' }}
                  >
                    {display}
                  </text>
                </g>
              )
            })}
          </g>
        </svg>
      )}
    </div>
  )
}
