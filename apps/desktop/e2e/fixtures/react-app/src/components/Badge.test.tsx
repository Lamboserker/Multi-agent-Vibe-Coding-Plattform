import { renderToStaticMarkup } from 'react-dom/server'
import { Badge } from './Badge'

describe('Badge', () => {
  it('renders its label', () => {
    expect(renderToStaticMarkup(<Badge label="new" />)).toBe('<span class="badge">new</span>')
  })
})
