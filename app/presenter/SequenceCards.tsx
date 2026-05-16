type SequenceResponse = {
  id: string
  created_at: string
  activity_id: string
  content: string
  participant_id: string | null
}

type ParticipantGroup = {
  cardKey: string        // unique per card: participantId:roundIndex
  participantId: string  // used for deterministic color
  responses: SequenceResponse[]
}

const PALETTE = [
  { bg: 'rgb(231 111 81 / 0.17)', accent: '#e76f51' },
  { bg: 'rgb(42 157 143 / 0.17)',  accent: '#2a9d8f' },
  { bg: 'rgb(138 177 125 / 0.17)', accent: '#8ab17d' },
  { bg: 'rgb(244 162 97 / 0.17)',  accent: '#f4a261' },
  { bg: 'rgb(233 196 106 / 0.17)', accent: '#e9c46a' },
]

function hashId(id: string): number {
  let h = 5381
  for (let i = 0; i < id.length; i++) {
    h = ((h << 5) + h) ^ id.charCodeAt(i)
  }
  return Math.abs(h)
}

function participantColor(pid: string) {
  return PALETTE[hashId(pid) % PALETTE.length]
}

function groupResponses(responses: SequenceResponse[]): ParticipantGroup[] {
  const map = new Map<string, SequenceResponse[]>()
  for (const r of responses) {
    const pid = r.participant_id ?? '__unknown__'
    if (!map.has(pid)) map.set(pid, [])
    map.get(pid)!.push(r)
  }

  const groups: ParticipantGroup[] = []
  for (const [participantId, resps] of map.entries()) {
    const sorted = [...resps].sort((a, b) => a.created_at.localeCompare(b.created_at))
    // Each round of 3 becomes its own card
    for (let i = 0; i < sorted.length; i += 3) {
      groups.push({
        cardKey: `${participantId}:${i / 3}`,
        participantId,
        responses: sorted.slice(i, i + 3),
      })
    }
  }

  // Newest card first
  groups.sort((a, b) => b.responses[0].created_at.localeCompare(a.responses[0].created_at))
  return groups
}

const SLOT_LABELS = ['LEARN', 'CHANGE', 'GROW'] as const

const VARIANT = {
  presenter: {
    columns: 'columns-3 gap-5',
    cardMb: 'mb-5',
    textSize: 'text-xl',
    emptyClass: 'text-lectern-slate/25 text-center py-20 text-2xl',
  },
  wall: {
    columns: 'columns-1 sm:columns-2 gap-4',
    cardMb: 'mb-3',
    textSize: 'text-base',
    emptyClass: 'text-lectern-slate/35 text-center py-16 text-lg',
  },
}

export function SequenceCards({
  responses,
  animatingIds,
  variant,
}: {
  responses: SequenceResponse[]
  animatingIds: Set<string>
  variant: 'presenter' | 'wall'
}) {
  const v = VARIANT[variant]
  const groups = groupResponses(responses)

  if (groups.length === 0) {
    return <p className={v.emptyClass}>No responses yet.</p>
  }

  return (
    <div className={v.columns}>
      {groups.map((group) => {
        const color = participantColor(group.participantId)
        const isNewCard = animatingIds.has(group.responses[0].id)

        return (
          <div
            key={group.cardKey}
            style={{ backgroundColor: color.bg }}
            className={[
              'rounded-xl p-3 break-inside-avoid shadow-sm',
              v.cardMb,
              isNewCard ? 'animate-slide-in' : '',
            ].join(' ')}
          >
            <div className="flex flex-col gap-2">
              {([0, 1, 2] as const).map((i) => {
                const response = group.responses[i]
                const label = SLOT_LABELS[i]

                if (response) {
                  const isSlotAnimating = animatingIds.has(response.id) && !isNewCard
                  return (
                    <div
                      key={i}
                      className={['rounded-lg p-2 bg-white/40', isSlotAnimating ? 'animate-slide-in' : ''].join(' ')}
                    >
                      <span
                        className="inline-block font-mono font-bold text-xs mb-1 rounded px-1.5 py-0.5 text-white"
                        style={{ backgroundColor: color.accent }}
                      >
                        {label}
                      </span>
                      <p className={`text-lectern-slate ${v.textSize} leading-snug`}>
                        {response.content}
                      </p>
                    </div>
                  )
                }

                return (
                  <div
                    key={i}
                    className="rounded-lg p-2"
                    style={{ border: `1.5px dashed ${color.accent}40` }}
                  >
                    <span
                      className="inline-block font-mono font-bold text-xs mb-1 rounded px-1.5 py-0.5"
                      style={{ color: color.accent, opacity: 0.4 }}
                    >
                      {label}
                    </span>
                    <p className="text-sm leading-snug" style={{ color: color.accent, opacity: 0.35 }}>
                      {label}…
                    </p>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}
