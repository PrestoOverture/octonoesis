import { type ToolItem, lineDelta, summarizeGroup } from '../shared/activity'

function Delta({ added, removed }: { added: number; removed: number }) {
  return (
    <>
      <span className="added">+{added}</span>
      <span className="removed">−{removed}</span>
    </>
  )
}

export function ToolCard({ tool }: { tool: ToolItem }) {
  const delta = lineDelta(tool)
  return (
    <div className={`tool ${tool.status}`}>
      <span className="tool-icon" aria-hidden="true">
        {tool.status === 'running' ? '◌' : tool.status === 'done' ? '✓' : '×'}
      </span>
      <strong>{tool.name}</strong>
      <code title={tool.argument}>{tool.argument}</code>
      {delta ? (
        <Delta {...delta} />
      ) : (
        <span className="tool-summary">
          {tool.status === 'running' ? 'running' : (tool.summary ?? tool.status)}
        </span>
      )}
    </div>
  )
}

export function ActivityGroup({ tools, live }: { tools: ToolItem[]; live: boolean }) {
  const summary = summarizeGroup(tools)
  return (
    <details className={`group ${live ? 'live' : ''}`}>
      <summary>
        <span className={live ? 'group-icon running' : 'group-icon'} aria-hidden="true">
          {live ? '◌' : '✓'}
        </span>
        <strong>{summary.title}</strong>
        {summary.file && <code className="group-file">{summary.file}</code>}
        {summary.title === 'Edited' && <Delta added={summary.added} removed={summary.removed} />}
        {summary.details.length > 0 && (
          <span className="muted group-details">{summary.details.join(', ')}</span>
        )}
        {summary.running && (
          <span className="group-running">
            <span className="separator">·</span> Running {summary.running.name}{' '}
            <code title={summary.running.argument}>{summary.running.argument}</code>
          </span>
        )}
        <span className="chevron" aria-hidden="true">
          ▾
        </span>
      </summary>
      <div className="group-body">
        {tools.map((tool) => (
          <ToolCard key={tool.id} tool={tool} />
        ))}
      </div>
    </details>
  )
}
