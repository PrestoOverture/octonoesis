import { useEffect, useRef, useState } from 'react'
import type { FileChange, HostCommand } from '../../../src/host/protocol'
import { rewindPlan, timelineRows } from '../shared/timeline'
import type { Transcript } from '../shared/transcript'

export type PanelTab = 'changes' | 'timeline' | 'learning'
type Props = {
  tab: PanelTab
  onTab: (tab: PanelTab) => void
  state: Transcript
  send: (command: HostCommand) => void
  onDismissRewindError: () => void
}

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

export function SidePanel({ tab, onTab, state, send, onDismissRewindError }: Props) {
  // Refresh on open, after each checkpoint and when a turn ends (shell commands may edit files).
  const checkpointCount = state.checkpoints.entries.length + state.checkpoints.commands.length
  const revertedCount = state.reverted.length
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch on these session milestones only.
  useEffect(() => {
    if (!state.connected || state.running) return
    if (tab === 'changes') send({ v: 1, type: 'get_changes' })
    if (tab === 'learning') send({ v: 1, type: 'get_learning' })
  }, [tab, state.connected, state.running, checkpointCount, revertedCount])
  return (
    <aside className="side-panel" aria-label="Session panel">
      <div className="panel-tabs" role="tablist">
        {(['changes', 'timeline', 'learning'] as const).map((name) => (
          <button
            type="button"
            role="tab"
            key={name}
            aria-selected={tab === name}
            onClick={() => onTab(name)}
          >
            {name === 'changes' ? 'Changes' : name === 'timeline' ? 'Timeline' : 'Learning'}
          </button>
        ))}
      </div>
      <div className="panel-body">
        {tab === 'changes' ? (
          <Changes state={state} />
        ) : tab === 'timeline' ? (
          <Timeline state={state} send={send} onDismissRewindError={onDismissRewindError} />
        ) : (
          <Learning state={state} />
        )}
      </div>
    </aside>
  )
}

function Changes({ state }: { state: Transcript }) {
  const files = state.changes
  return (
    <>
      {!files ? (
        <p className="panel-empty">Loading changes…</p>
      ) : !files.length ? (
        <p className="panel-empty">No file changes in this session yet.</p>
      ) : (
        <>
          <div className="panel-summary">
            {files.length} {files.length === 1 ? 'file' : 'files'} ·{' '}
            <span className="added">+{files.reduce((sum, file) => sum + file.added, 0)}</span>{' '}
            <span className="removed">−{files.reduce((sum, file) => sum + file.removed, 0)}</span>
          </div>
          {files.map((file) => (
            <FileDiff key={file.path} file={file} />
          ))}
        </>
      )}
      <p className="panel-note">
        Changes Noe made with Write and Edit, compared with each file before its first change. Shell
        commands are not tracked.
        {state.resumedFrom ? ' Changes from before this session was resumed are not shown.' : ''}
      </p>
    </>
  )
}

function FileDiff({ file }: { file: FileChange }) {
  return (
    <details className="file-diff">
      <summary>
        <span className={`file-status ${file.status}`} title={file.status}>
          {file.status === 'added' ? 'A' : file.status === 'deleted' ? 'D' : 'M'}
        </span>
        <code title={file.path}>{file.path}</code>
        {file.note ? (
          <span className="muted">{file.note === 'binary' ? 'binary' : 'too large'}</span>
        ) : (
          <span className="file-delta">
            <span className="added">+{file.added}</span>{' '}
            <span className="removed">−{file.removed}</span>
          </span>
        )}
      </summary>
      {file.patch && (
        <div className="diff">
          {file.patch.split('\n').map((line, index) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: patch lines are immutable for a response.
              key={index}
              className={
                line.startsWith('@@')
                  ? 'hunk'
                  : line.startsWith('+')
                    ? 'addition'
                    : line.startsWith('-')
                      ? 'deletion'
                      : ''
              }
            >
              {line || ' '}
            </div>
          ))}
        </div>
      )}
    </details>
  )
}

function Timeline({ state, send, onDismissRewindError }: Omit<Props, 'tab' | 'onTab'>) {
  const [target, setTarget] = useState<number>()
  const confirm = useRef<HTMLDialogElement>(null)
  const error = state.rewindError
  useEffect(() => {
    if (target !== undefined || error) confirm.current?.showModal()
    else confirm.current?.close()
  }, [target, error])
  const rows = timelineRows(state.checkpoints)
  const seq = target ?? error?.seq
  const plan = seq === undefined ? undefined : rewindPlan(state.checkpoints, seq)
  const close = () => {
    setTarget(undefined)
    onDismissRewindError()
  }
  const rewind = (force: boolean) => {
    if (seq === undefined) return
    send({ v: 1, type: 'rewind', seq, ...(force ? { force } : {}) })
    setTarget(undefined)
  }
  return (
    <>
      {!rows.length ? (
        <p className="panel-empty">No checkpoints yet. Each file Noe writes or edits adds one.</p>
      ) : (
        <ol className="timeline">
          {rows.map((row) =>
            row.kind === 'command' ? (
              <li key={`c${row.afterSeq}-${row.ts}`} className="timeline-command">
                <code title={row.command}>$ {row.command}</code>
                <span className="muted">{time(row.ts)}</span>
              </li>
            ) : (
              <li
                key={row.entry.seq}
                className={state.reverted.includes(row.entry.seq) ? 'reverted' : ''}
              >
                <div className="timeline-change">
                  <span className="muted">#{row.entry.seq}</span>
                  <span>
                    {row.entry.created ? 'Created' : row.entry.tool === 'Edit' ? 'Edited' : 'Wrote'}
                  </span>
                  <code title={row.entry.path}>{row.entry.path}</code>
                </div>
                <div className="timeline-meta">
                  <span className="muted">
                    {time(row.entry.ts)}
                    {state.reverted.includes(row.entry.seq) ? ' · reverted' : ''}
                  </span>
                  <button
                    type="button"
                    disabled={state.running || !state.connected}
                    title={
                      state.running
                        ? 'Wait for the current turn to finish'
                        : 'Restore files to how they were before this change'
                    }
                    onClick={() => setTarget(row.entry.seq)}
                  >
                    Rewind here
                  </button>
                </div>
              </li>
            ),
          )}
        </ol>
      )}
      <p className="panel-note">
        Rewinding restores the files only; the conversation stays and Noe is told which files
        changed. Shell commands are never undone.
      </p>
      <dialog ref={confirm} onCancel={close} aria-labelledby="rewind-title">
        {plan && seq !== undefined && (
          <>
            <h2 id="rewind-title">Rewind to before change #{seq}?</h2>
            {error && <p className="failure">{error.message}</p>}
            <ul className="rewind-files">
              {plan.files.map((file) => (
                <li key={file.path}>
                  <span className={file.action === 'delete' ? 'removed' : 'added'}>
                    {file.action === 'delete' ? 'delete' : 'restore'}
                  </span>{' '}
                  <code>{file.path}</code>
                </li>
              ))}
            </ul>
            {plan.commands.length > 0 && (
              <>
                <p>These shell commands ran after this point and will not be undone:</p>
                <ul className="rewind-commands">
                  {plan.commands.map((command, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: the plan is fixed while open.
                    <li key={index}>
                      <code>$ {command}</code>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <div className="permission-actions">
              <button type="button" onClick={close}>
                Cancel
              </button>
              {error?.conflict ? (
                <button type="button" className="bypass-confirm" onClick={() => rewind(true)}>
                  Overwrite and rewind
                </button>
              ) : (
                !error && (
                  <button type="button" className="primary" onClick={() => rewind(false)}>
                    Rewind
                  </button>
                )
              )}
            </div>
          </>
        )}
      </dialog>
    </>
  )
}

function Learning({ state }: { state: Transcript }) {
  const events = state.items.flatMap((item) => (item.kind === 'learning' ? [item.text] : []))
  const rules = state.rules
  return (
    <>
      <div className="panel-heading">This session</div>
      {events.length ? (
        <ul className="learning-events">
          {events.map((text, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: transcript entries are append-only.
            <li key={index}>{text}</li>
          ))}
        </ul>
      ) : (
        <p className="panel-empty">No rules recalled or learned yet.</p>
      )}
      <div className="panel-heading">Rule pool{rules ? ` · ${rules.length}` : ''}</div>
      {!rules ? (
        <p className="panel-empty">Loading rules…</p>
      ) : !rules.length ? (
        <p className="panel-empty">
          No rules yet. Noe distills rules from failures it recovers from.
        </p>
      ) : (
        rules.map((rule) => (
          <details key={rule.id} className="rule">
            <summary>
              <code title={rule.id}>{rule.id}</code>
              <span className={`rule-status ${rule.status}`}>{rule.status}</span>
              <span className="rule-confidence" title="Confidence">
                {Math.round(rule.confidence * 100)}%
              </span>
            </summary>
            <div className="rule-meter" aria-hidden="true">
              <span style={{ width: `${Math.round(rule.confidence * 100)}%` }} />
            </div>
            <p className="rule-stats">
              {rule.hits} helped · {rule.misses} missed · {rule.scope}
            </p>
            <p className="rule-advice">{rule.advice}</p>
          </details>
        ))
      )}
    </>
  )
}
