// The shape of the repository a journal record touched: the files it names and
// the files written around it, folded into a small tree drawn with guide
// lines. Pure, so the tests hold it without an engine.

import type { Contact } from '../types'

/** One drawn line of the tree: its depth, the guide drawn before it (`│  ├─ `), and what it names. */
export type TreeLine = { indent: number; guide: string; text: string; kind: 'dir' | 'file' | 'more'; isEdited: boolean; isSearched: boolean }

/** How many lines a tree draws before it folds files into counts, then cuts. */
export const TREE_LINES = 12
/** How many contacts an agent keeps between edits. */
export const CONTACTS_KEPT = 200

type Node = { name: string; children: Map<string, Node>; isFile: boolean; isEdited: boolean; isSearched: boolean }

const RANK: Record<Contact['kind'], number> = { search: 0, read: 1, edit: 2 }

/** The contacts with one more, each path once, its strongest kind kept (an edit over a read over a search), newest last. */
export function touched(contacts: readonly Contact[], more: readonly Contact[]): Contact[] {
  const out = [...contacts]
  for (const c of more) {
    if (c.path === '' && c.kind !== 'search') continue
    const at = out.findIndex(x => x.path === c.path)
    const was = out[at]
    if (was === undefined) out.push(c)
    else if (RANK[c.kind] > RANK[was.kind]) out[at] = c
  }
  return out.slice(-CONTACTS_KEPT)
}

function node(name: string): Node {
  return { name, children: new Map(), isFile: false, isEdited: false, isSearched: false }
}

/** Whether a searched path names a file rather than a folder: it has an extension. */
const looksLikeFile = (name: string): boolean => /\.[A-Za-z0-9]+$/.test(name)

function build(contacts: readonly Contact[]): { root: Node; isRootSearched: boolean } {
  const root = node('')
  let isRootSearched = false
  for (const c of contacts) {
    const parts = c.path.split('/').filter(p => p !== '' && p !== '.')
    if (parts.length === 0) {
      if (c.kind === 'search') isRootSearched = true
      continue
    }
    let at = root
    parts.forEach((part, i) => {
      const next = at.children.get(part) ?? node(part)
      at.children.set(part, next)
      at = next
      if (i === parts.length - 1) {
        at.isFile = c.kind !== 'search' || looksLikeFile(part)
        at.isEdited ||= c.kind === 'edit'
        at.isSearched ||= c.kind === 'search'
      }
    })
  }
  return { root, isRootSearched }
}

const isDir = (n: Node): boolean => n.children.size > 0 || !n.isFile
const order = (a: Node, b: Node): number => Number(isDir(b)) - Number(isDir(a)) || a.name.localeCompare(b.name)

/**
 * A folder's lines: its folders, files, a count of the files folded away and
 * one line for the folders only searched, each under the guide its place
 * draws. The top level stands bare; below it, `├─ ` marks an entry with
 * more after it, `└─ ` the last, and `│  ` carries an open branch down.
 */
function lines(dir: Node, depth: number, fold: boolean, guide: string): TreeLine[] {
  // Folders only searched, with nothing read in them, are one line: where the agent looked and found nothing to open.
  const searchedOnly = (k: Node): boolean => isDir(k) && k.children.size === 0 && k.isSearched
  const kids = [...dir.children.values()].sort(order).filter(k => !searchedOnly(k))
  const looked = [...dir.children.values()].filter(searchedOnly).map(k => `${k.name}/`).sort()
  const files = kids.filter(k => !isDir(k))
  const folded = fold && files.length > 2
  type Item = { line: Omit<TreeLine, 'indent' | 'guide'>; node?: Node }
  const items: Item[] = []
  for (const kid of kids) {
    if (!isDir(kid)) {
      if (folded && !kid.isEdited) continue
      items.push({ line: { text: kid.name, kind: 'file', isEdited: kid.isEdited, isSearched: kid.isSearched } })
      continue
    }
    // A folder holding one folder and nothing else draws as one line: src/adapters/.
    let name = kid.name
    let at = kid
    while (at.children.size === 1 && !at.isSearched) {
      const only = [...at.children.values()][0]
      if (only === undefined || !isDir(only)) break
      name += `/${only.name}`
      at = only
    }
    items.push({ line: { text: `${name}/`, kind: 'dir', isEdited: false, isSearched: false }, node: at })
  }
  const hidden = folded ? files.filter(f => !f.isEdited).length : 0
  if (hidden > 0) items.push({ line: { text: `${hidden} file${hidden === 1 ? '' : 's'}`, kind: 'more', isEdited: false, isSearched: false } })
  if (looked.length > 0) items.push({ line: { text: `searched ${looked.join(' ')}`, kind: 'more', isEdited: false, isSearched: true } })
  const out: TreeLine[] = []
  items.forEach((item, i) => {
    const isLast = i === items.length - 1
    out.push({ ...item.line, indent: depth, guide: depth === 0 ? '' : `${guide}${isLast ? '└─ ' : '├─ '}` })
    if (item.node !== undefined) out.push(...lines(item.node, depth + 1, fold, depth === 0 ? '' : `${guide}${isLast ? '   ' : '│  '}`))
  })
  return out
}

/**
 * The tree the contacts make, at most `max` lines: in full when it fits, else
 * with each folder's unedited files folded into a count, else cut with a count
 * of the lines left out. A search of the whole project heads it.
 */
export function treeOf(contacts: readonly Contact[], max = TREE_LINES): TreeLine[] {
  const { root, isRootSearched } = build(contacts)
  const head: TreeLine[] = isRootSearched ? [{ indent: 0, guide: '', text: 'searched the whole project', kind: 'more', isEdited: false, isSearched: true }] : []
  const full = [...head, ...lines(root, 0, false, '')]
  if (full.length <= max) return full
  const folded = [...head, ...lines(root, 0, true, '')]
  if (folded.length <= max) return folded
  const left = folded.length - (max - 1)
  return [...folded.slice(0, max - 1), { indent: 0, guide: '', text: `… ${left} more line${left === 1 ? '' : 's'}`, kind: 'more', isEdited: false, isSearched: false }]
}
