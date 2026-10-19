/** Web links in terminal output (dev servers, docs, CI URLs), opened with Ctrl+click like in VS Code. */

export interface TextLink {
  /** 0-based index of the first character. */
  start: number
  /** 0-based index after the last character. */
  end: number
  url: string
}

const URL_PATTERN = /\bhttps?:\/\/[^\s"'`<>()[\]{}|\\^]+/g
// punctuation that ends a sentence or a quote, not the URL
const TRAILING = /[.,;:!?'"*]+$/

export function findLinks(text: string): TextLink[] {
  const links: TextLink[] = []
  for (const match of text.matchAll(URL_PATTERN)) {
    const raw = match[0].replace(TRAILING, '')
    if (raw.length <= 'https://'.length) continue
    try {
      // only well-formed URLs with a host
      if (!new URL(raw).hostname) continue
    } catch {
      continue
    }
    links.push({ start: match.index!, end: match.index! + raw.length, url: raw })
  }
  return links
}

/** Ctrl (Windows/Linux) or Cmd (macOS) held while clicking. */
export const isLinkModifier = (event: Pick<MouseEvent, 'ctrlKey' | 'metaKey'>) => event.ctrlKey || event.metaKey
