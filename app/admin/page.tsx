'use client'

import { useEffect, useRef, useState } from 'react'
import { supabase } from '@/lib/supabase'

type ActivityType = 'text' | 'rating' | 'wordcloud' | 'sequence'

type SequenceOptions = { prompts: [string, string, string] }
type RatingOptions  = { choices: string[] }

type Activity = {
  id: string
  created_at: string
  title: string
  is_active: boolean
  type: ActivityType
  options: RatingOptions | SequenceOptions | null
}

type ActivityWithCount = Activity & { responseCount: number }

const TYPE_BADGE: Record<ActivityType, { label: string; className: string }> = {
  text:      { label: 'TEXT',      className: 'bg-lectern-slate/8 text-lectern-slate/60' },
  rating:    { label: 'RATING',    className: 'bg-lectern-teal/10 text-lectern-sage' },
  wordcloud: { label: 'WORDCLOUD', className: 'bg-lectern-sand/55 text-lectern-slate/60' },
  sequence:  { label: 'SEQUENCE',  className: 'bg-lectern-orange/10 text-lectern-orange' },
}

function TypeBadge({ type }: { type: ActivityType }) {
  const { label, className } = TYPE_BADGE[type] ?? TYPE_BADGE.text
  return (
    <span className={`shrink-0 px-1.5 py-0.5 rounded text-xs font-semibold tracking-wide ${className}`}>
      {label}
    </span>
  )
}

function sequencePrompts(activity: Activity): [string, string, string] {
  return (activity.options as SequenceOptions | null)?.prompts ?? ['', '', '']
}

const EMPTY_PROMPTS: [string, string, string] = ['', '', '']

export default function AdminPage() {
  const [activities, setActivities] = useState<ActivityWithCount[]>([])
  const [loading, setLoading] = useState(true)
  const [newTitle, setNewTitle] = useState('')
  const [newType, setNewType] = useState<ActivityType>('text')
  const [newSequencePrompts, setNewSequencePrompts] = useState<[string, string, string]>([...EMPTY_PROMPTS])
  const [creating, setCreating] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const [editingSequencePrompts, setEditingSequencePrompts] = useState<[string, string, string]>([...EMPTY_PROMPTS])
  const editInputRef = useRef<HTMLInputElement>(null)
  // Prevents double-save when Enter triggers blur after keydown handler commits
  const commitRef = useRef(false)

  async function fetchAll() {
    const [{ data: acts }, { data: resps }] = await Promise.all([
      supabase.from('activities').select('*').order('created_at', { ascending: false }),
      supabase.from('responses').select('activity_id'),
    ])

    if (!acts) return

    const counts: Record<string, number> = {}
    for (const r of resps ?? []) {
      counts[r.activity_id] = (counts[r.activity_id] ?? 0) + 1
    }

    setActivities(acts.map((a) => ({ ...a, responseCount: counts[a.id] ?? 0 })))
  }

  useEffect(() => {
    fetchAll().then(() => setLoading(false))

    const activitiesChannel = supabase
      .channel('admin-activities')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'activities' }, () => {
        fetchAll()
      })
      .subscribe()

    const responsesChannel = supabase
      .channel('admin-responses')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'responses' },
        (payload) => {
          const activityId = (payload.new as { activity_id: string }).activity_id
          setActivities((prev) =>
            prev.map((a) =>
              a.id === activityId ? { ...a, responseCount: a.responseCount + 1 } : a
            )
          )
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(activitiesChannel)
      supabase.removeChannel(responsesChannel)
    }
  }, [])

  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus()
      editInputRef.current.select()
    }
  }, [editingId])

  async function createActivity() {
    if (creating) return
    setCreating(true)

    if (newType === 'sequence') {
      const prompts = newSequencePrompts.map((p) => p.trim()) as [string, string, string]
      if (!prompts.every((p) => p)) { setCreating(false); return }
      await supabase.from('activities').insert({
        title: prompts[0],
        is_active: false,
        type: 'sequence',
        options: { prompts },
      })
      setNewSequencePrompts([...EMPTY_PROMPTS])
    } else {
      if (!newTitle.trim()) { setCreating(false); return }
      const record: Record<string, unknown> = { title: newTitle.trim(), is_active: false, type: newType }
      if (newType === 'rating') record.options = { choices: ['low', 'medium', 'high'] }
      await supabase.from('activities').insert(record)
      setNewTitle('')
    }

    setCreating(false)
  }

  // Set target active first (no "no active" window for participants),
  // then clear all others.
  async function setActive(id: string) {
    await supabase.from('activities').update({ is_active: true }).eq('id', id)
    await supabase.from('activities').update({ is_active: false }).neq('id', id)
  }

  async function pauseAll() {
    await supabase.from('activities').update({ is_active: false }).eq('is_active', true)
  }

  function startEdit(activity: ActivityWithCount) {
    commitRef.current = false
    setEditingId(activity.id)
    if (activity.type === 'sequence') {
      setEditingSequencePrompts([...sequencePrompts(activity)])
    } else {
      setEditingTitle(activity.title)
    }
  }

  async function saveTitle(id: string, title: string) {
    if (commitRef.current) return
    commitRef.current = true
    setEditingId(null)
    const trimmed = title.trim()
    if (trimmed) {
      await supabase.from('activities').update({ title: trimmed }).eq('id', id)
    }
  }

  async function saveSequencePrompts(id: string, prompts: [string, string, string]) {
    if (commitRef.current) return
    commitRef.current = true
    setEditingId(null)
    const trimmed = prompts.map((p) => p.trim()) as [string, string, string]
    if (trimmed.every((p) => p)) {
      await supabase.from('activities').update({
        title: trimmed[0],
        options: { prompts: trimmed },
      }).eq('id', id)
    }
  }

  function cancelEdit() {
    if (commitRef.current) return
    commitRef.current = true
    setEditingId(null)
  }

  async function clearResponses(id: string) {
    if (!confirm('Delete all responses for this activity?')) return
    // Optimistic update — realtime DELETE events don't carry activity_id without
    // REPLICA IDENTITY FULL, so we update the count locally instead of re-fetching.
    setActivities((prev) =>
      prev.map((a) => (a.id === id ? { ...a, responseCount: 0 } : a))
    )
    await supabase.from('responses').delete().eq('activity_id', id)
  }

  async function deleteActivity(id: string) {
    if (!confirm('Delete this activity and all its responses?')) return
    await supabase.from('activities').delete().eq('id', id)
  }

  const hasActive = activities.some((a) => a.is_active)
  const canCreate = newType === 'sequence'
    ? newSequencePrompts.every((p) => p.trim()) && !creating
    : !!newTitle.trim() && !creating

  if (loading) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <p className="text-lectern-slate/40">Loading…</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-white p-8">
      <div className="max-w-4xl mx-auto">
        <h1 className="text-2xl font-bold text-lectern-slate mb-6">Activity Admin</h1>

        <div className="flex flex-col gap-3 mb-1">
          <div className="flex gap-3">
            {newType !== 'sequence' && (
              <input
                type="text"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && createActivity()}
                placeholder="Enter activity prompt…"
                className="flex-1 border border-lectern-slate/20 rounded-lg px-3 py-2 text-lectern-slate placeholder-lectern-slate/40 focus:outline-none focus:ring-2 focus:ring-lectern-coral/50"
              />
            )}
            <select
              value={newType}
              onChange={(e) => setNewType(e.target.value as ActivityType)}
              className="border border-lectern-slate/20 rounded-lg px-3 py-2 text-lectern-slate bg-white focus:outline-none focus:ring-2 focus:ring-lectern-coral/50"
            >
              <option value="text">Text</option>
              <option value="rating">Rating</option>
              <option value="wordcloud">Word Cloud</option>
              <option value="sequence">Sequence</option>
            </select>
            <button
              onClick={createActivity}
              disabled={!canCreate}
              className="px-4 py-2 bg-lectern-slate text-white rounded-lg hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
            >
              {creating ? 'Creating…' : 'Create Activity'}
            </button>
            {hasActive && (
              <button
                onClick={pauseAll}
                className="px-4 py-2 bg-lectern-orange text-white rounded-lg hover:opacity-90 transition-opacity"
              >
                Pause
              </button>
            )}
          </div>

          {newType === 'sequence' && (
            <div className="flex flex-col gap-2">
              {([0, 1, 2] as const).map((i) => (
                <div key={i} className="flex items-center gap-3">
                  <label className="text-sm text-lectern-slate/60 shrink-0 w-16">
                    Prompt {i + 1}
                  </label>
                  <input
                    type="text"
                    value={newSequencePrompts[i]}
                    onChange={(e) => {
                      const p = [...newSequencePrompts] as [string, string, string]
                      p[i] = e.target.value
                      setNewSequencePrompts(p)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && i === 2) createActivity()
                    }}
                    placeholder={`Enter prompt ${i + 1}…`}
                    className="flex-1 border border-lectern-slate/20 rounded-lg px-3 py-2 text-lectern-slate placeholder-lectern-slate/40 focus:outline-none focus:ring-2 focus:ring-lectern-coral/50"
                  />
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="mb-5" />

        {activities.length === 0 ? (
          <p className="text-lectern-slate/40">No activities yet.</p>
        ) : (
          <div className="border border-lectern-slate/10 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-lectern-slate/5 text-lectern-slate/60 text-left">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Title</th>
                  <th className="px-4 py-2.5 font-medium">Created</th>
                  <th className="px-4 py-2.5 font-medium">Responses</th>
                  <th className="px-4 py-2.5 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-lectern-slate/8">
                {activities.map((activity) => {
                  const isEditingThis = editingId === activity.id
                  const isSequence = activity.type === 'sequence'

                  return (
                    <tr
                      key={activity.id}
                      className={activity.is_active ? 'bg-lectern-coral/8' : ''}
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-start gap-2">
                          <TypeBadge type={activity.type ?? 'text'} />
                          {activity.is_active && (
                            <span className="shrink-0 inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-semibold bg-lectern-coral text-white">
                              <span className="w-1.5 h-1.5 rounded-full bg-white animate-live-pulse" />
                              Live
                            </span>
                          )}

                          {isEditingThis && isSequence ? (
                            <div className="flex-1 space-y-1.5">
                              {([0, 1, 2] as const).map((i) => (
                                <input
                                  key={i}
                                  ref={i === 0 ? editInputRef : undefined}
                                  type="text"
                                  value={editingSequencePrompts[i]}
                                  onChange={(e) => {
                                    const p = [...editingSequencePrompts] as [string, string, string]
                                    p[i] = e.target.value
                                    setEditingSequencePrompts(p)
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') saveSequencePrompts(activity.id, editingSequencePrompts)
                                    if (e.key === 'Escape') cancelEdit()
                                  }}
                                  placeholder={`Prompt ${i + 1}`}
                                  className="w-full border border-lectern-slate/20 rounded px-2 py-1 text-lectern-slate focus:outline-none focus:ring-2 focus:ring-lectern-coral/50"
                                />
                              ))}
                              <div className="flex gap-2 pt-0.5">
                                <button
                                  onClick={() => saveSequencePrompts(activity.id, editingSequencePrompts)}
                                  disabled={!editingSequencePrompts.every((p) => p.trim())}
                                  className="px-2 py-1 text-xs bg-lectern-slate text-white rounded hover:opacity-80 disabled:opacity-40 transition-opacity"
                                >
                                  Save
                                </button>
                                <button
                                  onClick={cancelEdit}
                                  className="px-2 py-1 text-xs border border-lectern-slate/20 text-lectern-slate/60 rounded hover:bg-lectern-slate/5 transition-colors"
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : isEditingThis ? (
                            <input
                              ref={editInputRef}
                              type="text"
                              value={editingTitle}
                              onChange={(e) => setEditingTitle(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') saveTitle(activity.id, editingTitle)
                                if (e.key === 'Escape') cancelEdit()
                              }}
                              onBlur={() => saveTitle(activity.id, editingTitle)}
                              className="border border-lectern-slate/20 rounded px-2 py-1 text-lectern-slate focus:outline-none focus:ring-2 focus:ring-lectern-coral/50 w-full min-w-0"
                            />
                          ) : isSequence ? (
                            <div
                              className="cursor-pointer space-y-0.5"
                              onClick={() => startEdit(activity)}
                              title="Click to edit"
                            >
                              {sequencePrompts(activity).map((prompt, i) => (
                                <div key={i} className="text-lectern-slate leading-snug">
                                  <span className="text-lectern-slate/40 text-xs mr-1.5 tabular-nums">
                                    {i + 1}.
                                  </span>
                                  {prompt}
                                </div>
                              ))}
                            </div>
                          ) : (
                            <span
                              className="cursor-pointer hover:underline text-lectern-slate"
                              onClick={() => startEdit(activity)}
                              title="Click to edit"
                            >
                              {activity.title}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-lectern-slate/50 whitespace-nowrap">
                        {new Date(activity.created_at).toLocaleString()}
                      </td>
                      <td className="px-4 py-3 text-lectern-slate tabular-nums font-medium">
                        {activity.responseCount}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex gap-2 flex-wrap">
                          {!activity.is_active && !isEditingThis && (
                            <button
                              onClick={() => setActive(activity.id)}
                              className="px-2 py-1 text-xs bg-lectern-slate text-white rounded hover:opacity-80 transition-opacity"
                            >
                              Set Active
                            </button>
                          )}
                          {!isEditingThis && (
                            <>
                              <button
                                onClick={() => clearResponses(activity.id)}
                                className="px-2 py-1 text-xs border border-lectern-slate/20 text-lectern-slate/60 rounded hover:bg-lectern-slate/5 transition-colors"
                              >
                                Clear responses
                              </button>
                              <button
                                onClick={() => deleteActivity(activity.id)}
                                className="px-2 py-1 text-xs border border-lectern-coral/30 text-lectern-coral rounded hover:bg-lectern-coral/8 transition-colors"
                              >
                                Delete
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
