import { expect, test } from 'bun:test'
import { Fragment, type ReactNode, isValidElement } from 'react'
import { Markdown } from './Markdown'

const escapeHtml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// Markdown emits only intrinsic elements and fragments, so a small serializer stands in for
// react-dom/server, which root CI does not install (desktop/node_modules is hutch-managed).
function toHtml(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return escapeHtml(String(node))
  if (Array.isArray(node)) return node.map(toHtml).join('')
  if (!isValidElement<Record<string, unknown>>(node)) throw new Error('Unexpected node')
  const children = toHtml(node.props.children as ReactNode)
  if (node.type === Fragment) return children
  if (typeof node.type !== 'string') throw new Error('Markdown must emit intrinsic elements')
  const attributes = Object.entries(node.props)
    .filter(([name, value]) => name !== 'children' && typeof value !== 'function')
    .filter(([, value]) => value !== undefined && typeof value !== 'object')
    .map(
      ([name, value]) => ` ${name === 'className' ? 'class' : name}="${escapeHtml(String(value))}"`,
    )
    .join('')
  if (node.type === 'hr' || node.type === 'br') return `<${node.type}${attributes}/>`
  return `<${node.type}${attributes}>${children}</${node.type}>`
}

const render = (text: string) => toHtml(Markdown({ text, onOpenExternal: () => {} }))

test('markdown maps headings, paragraphs, emphasis, strong and inline code to elements', () => {
  const html = render('# Title\n\nA *small* **strong** `code` sample.\n\n---')
  for (const fragment of [
    '<h1>Title</h1>',
    '<p>A <em>small</em> <strong>strong</strong> <code>code</code> sample.</p>',
    '<hr',
  ])
    expect(html).toContain(fragment)
})

test('fenced code has a language label and escaped text; unfinished streamed fences stay code', () => {
  const source = '```ts\nconst value = "<script>";\n'
  for (const text of [source, `${source}\u0060\u0060\u0060`]) {
    const html = render(text)
    expect(html).toContain('class="code-language">ts</div>')
    expect(html).toContain('<pre><code>const value = &quot;&lt;script&gt;&quot;;</code></pre>')
    expect(html.includes('<script>')).toBe(false)
  }
})

test('GFM nested ordered/unordered lists, blockquotes and tables become structured elements', () => {
  const html = render(
    '1. first\n   - nested\n2. second\n\n> quote\n\n| Name | Value |\n| --- | ---: |\n| one | **two** |',
  )
  for (const fragment of [
    '<ol',
    '<ul>',
    '<li>',
    'nested',
    '<blockquote>',
    '<table>',
    '<th',
    '<td',
    '<strong>two</strong>',
  ])
    expect(html).toContain(fragment)
})

test('raw inline/block HTML and images stay text and cannot create executable or remote nodes', () => {
  const html = render(
    '<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>\n\nInline <b>bold</b> ![remote](https://example.com/image.png)',
  )
  expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  expect(html).toContain('&lt;img src=x onerror=alert(2)&gt;')
  expect(html).toContain('&lt;b&gt;')
  expect(html).toContain('![remote](https://example.com/image.png)')
  expect(html.includes('<script')).toBe(false)
  expect(html.includes('<img')).toBe(false)
  expect(html.includes('<b>')).toBe(false)
})

test('HTTP links are anchors; javascript, file, data and relative links stay inert', () => {
  const html = render(
    '[safe](https://example.com/path) [http](http://example.com) [bad](javascript:alert) [file](file:///tmp/a) [data](data:text/html,hi) [relative](/path)',
  )
  expect(html).toContain('href="https://example.com/path"')
  expect(html).toContain('href="http://example.com/"')
  for (const protocol of ['javascript:', 'file:', 'data:', 'href="/path"'])
    expect(html.includes(protocol)).toBe(false)
})

test('anchor primary and middle clicks prevent webview navigation and delegate to opener', () => {
  const opened: string[] = []
  const tree = Markdown({
    text: '[safe](https://example.com)',
    onOpenExternal: (url) => opened.push(url),
  })
  function findAnchor(node: ReactNode): Record<string, unknown> | undefined {
    if (Array.isArray(node)) return node.map(findAnchor).find(Boolean)
    if (!isValidElement<Record<string, unknown>>(node)) return undefined
    if (node.type === 'a') return node.props
    return findAnchor(node.props.children as ReactNode)
  }
  const props = findAnchor(tree)
  if (!props) throw new Error('Missing anchor')
  let prevented = 0
  const event = {
    button: 1,
    preventDefault: () => {
      prevented++
    },
  }
  ;(props.onClick as (input: typeof event) => void)(event)
  ;(props.onAuxClick as (input: typeof event) => void)(event)
  expect(prevented).toBe(2)
  expect(opened).toEqual(['https://example.com/', 'https://example.com/'])
})
