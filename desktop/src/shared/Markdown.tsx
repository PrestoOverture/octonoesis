import { type MarkedToken, type Token, lexer } from 'marked'
import { Fragment, type ReactNode, createElement } from 'react'
import { externalUrl } from './externalUrl'

type OpenExternal = (url: string) => void

/** Default GFM tokens become elements and text nodes, never parsed HTML. */
function elements(tokens: Token[], open: OpenExternal): ReactNode[] {
  return tokens.map((value, index) => {
    // No marked extensions are installed, so the lexer emits built-in tokens only.
    const token = value as MarkedToken
    const children = 'tokens' in token && token.tokens ? elements(token.tokens, open) : null
    const key = `${index}:${token.type}`
    switch (token.type) {
      case 'space':
      case 'def':
        return null
      case 'paragraph':
        return <p key={key}>{children}</p>
      case 'heading':
        return createElement(`h${token.depth}`, { key }, children)
      case 'strong':
        return <strong key={key}>{children}</strong>
      case 'em':
        return <em key={key}>{children}</em>
      case 'del':
        return <del key={key}>{children}</del>
      case 'br':
        return <br key={key} />
      case 'hr':
        return <hr key={key} />
      case 'blockquote':
        return <blockquote key={key}>{children}</blockquote>
      case 'codespan':
        return <code key={key}>{token.text}</code>
      case 'code':
        return (
          <section className="markdown-code" key={key}>
            <div className="code-language">{token.lang?.split(/\s+/)[0] || 'code'}</div>
            <pre>
              <code>{token.text}</code>
            </pre>
          </section>
        )
      case 'list': {
        const items = token.items.map((item, position) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: lexer token positions identify stateless list items.
          <li key={`${key}:${position}`}>
            {item.task ? (item.checked ? '☑ ' : '☐ ') : null}
            {elements(item.tokens, open)}
          </li>
        ))
        return token.ordered ? (
          <ol key={key} start={Number(token.start) || 1}>
            {items}
          </ol>
        ) : (
          <ul key={key}>{items}</ul>
        )
      }
      case 'list_item':
        return <li key={key}>{children}</li>
      case 'table':
        return (
          <div className="markdown-table" key={key}>
            <table>
              <thead>
                <tr>
                  {token.header.map((cell, column) => (
                    <th
                      // biome-ignore lint/suspicious/noArrayIndexKey: cells are identified by their table coordinates.
                      key={`${key}:head:${column}`}
                      style={{ textAlign: cell.align ?? undefined }}
                    >
                      {elements(cell.tokens, open)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {token.rows.map((row, position) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: rows are identified by their table coordinates.
                  <tr key={`${key}:row:${position}`}>
                    {row.map((cell, column) => (
                      <td
                        // biome-ignore lint/suspicious/noArrayIndexKey: cells are identified by their table coordinates.
                        key={`${key}:${position}:${column}`}
                        style={{ textAlign: cell.align ?? undefined }}
                      >
                        {elements(cell.tokens, open)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      case 'link': {
        const href = externalUrl(token.href)
        if (!href) return <span key={key}>{children}</span>
        return (
          <a
            key={key}
            href={href}
            title={token.title ?? undefined}
            onClick={(event) => {
              event.preventDefault()
              open(href)
            }}
            onAuxClick={(event) => {
              event.preventDefault()
              if (event.button === 1) open(href)
            }}
            onContextMenu={(event) => event.preventDefault()}
          >
            {children}
          </a>
        )
      }
      case 'text':
        return <Fragment key={key}>{children ?? token.text}</Fragment>
      case 'escape':
        return <Fragment key={key}>{token.text}</Fragment>
      case 'html':
        return (
          <span className="markdown-literal" key={key}>
            {token.text}
          </span>
        )
      // Images stay literal: assistant content must not load remote resources.
      case 'image':
        return <span key={key}>{token.raw}</span>
      case 'checkbox':
        return <Fragment key={key}>{token.checked ? '☑ ' : '☐ '}</Fragment>
    }
  })
}

export function Markdown({ text, onOpenExternal }: { text: string; onOpenExternal: OpenExternal }) {
  return <div className="markdown">{elements(lexer(text, { gfm: true }), onOpenExternal)}</div>
}
