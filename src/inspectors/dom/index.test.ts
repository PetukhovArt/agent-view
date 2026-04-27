import { describe, it, expect } from 'vitest'
import type { AXNode } from '../../cdp/types.js'
import { formatAccessibilityTree, countAccessibilityNodes } from './index.js'

function node(
  nodeId: string,
  role: string,
  name?: string,
  childIds?: string[],
  backendDOMNodeId?: number,
): AXNode {
  return {
    nodeId,
    role: { value: role },
    ...(name !== undefined ? { name: { value: name } } : {}),
    ...(childIds ? { childIds } : {}),
    ...(backendDOMNodeId !== undefined ? { backendDOMNodeId } : {}),
  }
}

describe('formatAccessibilityTree', () => {
  it('returns (empty) for empty node list', () => {
    const result = formatAccessibilityTree([])
    expect(result.text).toBe('(empty)')
    expect(result.refs).toEqual([])
    expect(result.nextRef).toBe(1)
  })

  it('single root node: formats role, name, ref', () => {
    const nodes = [node('1', 'button', 'Submit', undefined, 10)]
    const result = formatAccessibilityTree(nodes)
    expect(result.text).toBe('button "Submit" [ref=1]')
    expect(result.refs).toEqual([{ ref: 1, backendDOMNodeId: 10 }])
    expect(result.nextRef).toBe(2)
  })

  it('node without backendDOMNodeId is not added to refs', () => {
    const nodes = [node('1', 'button', 'Submit')]
    const result = formatAccessibilityTree(nodes)
    expect(result.refs).toEqual([])
    expect(result.text).toBe('button "Submit" [ref=1]')
  })

  it('children render with 2-space indentation', () => {
    const nodes = [
      node('1', 'group', 'Parent', ['2', '3']),
      node('2', 'button', 'Child A'),
      node('3', 'button', 'Child B'),
    ]
    const result = formatAccessibilityTree(nodes)
    const lines = result.text.split('\n')
    expect(lines[0]).toBe('group "Parent" [ref=1]')
    expect(lines[1]).toBe('  button "Child A" [ref=2]')
    expect(lines[2]).toBe('  button "Child B" [ref=3]')
  })

  it('InlineTextBox role is always skipped', () => {
    const nodes = [
      node('1', 'button', 'Click', ['2']),
      node('2', 'InlineTextBox', 'text'),
    ]
    const result = formatAccessibilityTree(nodes)
    expect(result.text).not.toContain('InlineTextBox')
    expect(result.text).toBe('button "Click" [ref=1]')
  })

  it('generic/none/StaticText without name AND no fallback are skipped but children still rendered', () => {
    // Children have no names, so fallback resolution returns '' → parent is skipped
    const skippedRoles = ['generic', 'none', 'StaticText'] as const
    for (const role of skippedRoles) {
      const nodes = [
        node('1', role, undefined, ['2']),
        // child has no name → fallback for parent resolves to ''
        node('2', 'button'),
      ]
      const result = formatAccessibilityTree(nodes)
      // skipped role should not appear as a line with its role name
      expect(result.text).not.toMatch(new RegExp(`^${role}`, 'm'))
      // child should still render (at same indent since parent skipped)
      expect(result.text).toContain('button [ref=')
    }
  })

  it('generic/none/StaticText WITH name are not skipped', () => {
    const nodes = [node('1', 'generic', 'HasName', undefined, 5)]
    const result = formatAccessibilityTree(nodes)
    expect(result.text).toBe('generic "HasName" [ref=1]')
  })

  it('filter by name is case-insensitive', () => {
    const nodes = [
      node('1', 'group', undefined, ['2', '3']),
      node('2', 'button', 'Submit'),
      node('3', 'button', 'Cancel'),
    ]
    const result = formatAccessibilityTree(nodes, { filter: 'SUBMIT' })
    expect(result.text).toContain('Submit')
    expect(result.text).not.toContain('Cancel')
  })

  it('filter: node matches if role contains filter string', () => {
    const nodes = [
      node('1', 'group', undefined, ['2', '3']),
      node('2', 'button', 'OK'),
      node('3', 'textbox', 'Input'),
    ]
    const result = formatAccessibilityTree(nodes, { filter: 'textbox' })
    expect(result.text).toContain('textbox')
    expect(result.text).not.toContain('button')
  })

  it('depth limit respected', () => {
    const nodes = [
      node('1', 'group', 'Root', ['2']),
      node('2', 'group', 'Level1', ['3']),
      node('3', 'button', 'Level2'),
    ]
    const result = formatAccessibilityTree(nodes, { depth: 1 })
    const lines = result.text.split('\n')
    // Root at depth 0 (indent=0) and Level1 at indent=1 should appear
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('Root')
    expect(lines[1]).toContain('Level1')
    // Level2 at indent=2 should be excluded
    expect(result.text).not.toContain('Level2')
  })

  it('startRef continues numbering from given value', () => {
    const nodes = [node('1', 'button', 'OK', undefined, 20)]
    const result = formatAccessibilityTree(nodes, { startRef: 5 })
    expect(result.text).toBe('button "OK" [ref=5]')
    expect(result.refs).toEqual([{ ref: 5, backendDOMNodeId: 20 }])
    expect(result.nextRef).toBe(6)
  })

  it('fallback name resolved from children, marked with [fallback]', () => {
    const nodes = [
      node('1', 'listitem', undefined, ['2']),
      node('2', 'StaticText', 'Resolved'),
    ]
    const result = formatAccessibilityTree(nodes)
    expect(result.text).toContain('"Resolved" [fallback]')
    expect(result.text).toContain('listitem')
  })

  it('no name and no fallback: nameStr is empty', () => {
    const nodes = [node('1', 'button')]
    const result = formatAccessibilityTree(nodes)
    expect(result.text).toBe('button [ref=1]')
  })

  it('empty after filter returns (no matching elements)', () => {
    const nodes = [node('1', 'button', 'OK')]
    const result = formatAccessibilityTree(nodes, { filter: 'nonexistent' })
    expect(result.text).toBe('(no matching elements)')
  })

  it('nested refs are assigned in depth-first order', () => {
    const nodes = [
      node('1', 'group', 'G', ['2', '3'], 100),
      node('2', 'button', 'A', undefined, 101),
      node('3', 'button', 'B', undefined, 102),
    ]
    const result = formatAccessibilityTree(nodes)
    expect(result.refs[0]).toEqual({ ref: 1, backendDOMNodeId: 100 })
    expect(result.refs[1]).toEqual({ ref: 2, backendDOMNodeId: 101 })
    expect(result.refs[2]).toEqual({ ref: 3, backendDOMNodeId: 102 })
    expect(result.nextRef).toBe(4)
  })
})

describe('countAccessibilityNodes', () => {
  it('returns 0 for empty node list', () => {
    expect(countAccessibilityNodes([]).count).toBe(0)
  })

  it('counts all visible nodes without filter', () => {
    const nodes = [
      node('1', 'group', 'Root', ['2', '3']),
      node('2', 'button', 'A'),
      node('3', 'button', 'B'),
    ]
    // group + button A + button B = 3
    expect(countAccessibilityNodes(nodes).count).toBe(3)
  })

  it('count with filter — only matching branch counted', () => {
    // The group is unnamed and 'group' is not in SKIP_WHEN_EMPTY_ROLES,
    // so it passes the filter check (hasMatchingDescendant returns true for Submit).
    // group + button Submit = 2; Cancel is excluded.
    const nodes = [
      node('1', 'group', undefined, ['2', '3']),
      node('2', 'button', 'Submit'),
      node('3', 'button', 'Cancel'),
    ]
    expect(countAccessibilityNodes(nodes, { filter: 'Submit' }).count).toBe(2)
  })

  it('count with no matches returns 0', () => {
    const nodes = [node('1', 'button', 'OK')]
    expect(countAccessibilityNodes(nodes, { filter: 'nonexistent' }).count).toBe(0)
  })

  it('count with depth limit respects maxDepth', () => {
    const nodes = [
      node('1', 'group', 'Root', ['2']),
      node('2', 'group', 'Level1', ['3']),
      node('3', 'button', 'Level2'),
    ]
    // depth=1: Root (indent=0) + Level1 (indent=1) — Level2 at indent=2 excluded
    expect(countAccessibilityNodes(nodes, { depth: 1 }).count).toBe(2)
  })

  it('always-skip roles (InlineTextBox) are not counted', () => {
    const nodes = [
      node('1', 'button', 'Click', ['2']),
      node('2', 'InlineTextBox', 'text'),
    ]
    expect(countAccessibilityNodes(nodes).count).toBe(1)
  })

  it('skip-when-empty roles without resolvable name are not counted but children still are', () => {
    // generic has no own name, child button has no name either → fallback resolves to '' → skip=true
    // generic itself is not counted; child button (not in skip set) is counted → 1
    const nodes = [
      node('1', 'generic', undefined, ['2']),
      node('2', 'button'),
    ]
    expect(countAccessibilityNodes(nodes).count).toBe(1)
  })

  it('count matches line count from formatter (no filter)', () => {
    const nodes = [
      node('1', 'group', 'G', ['2', '3'], 100),
      node('2', 'button', 'A', undefined, 101),
      node('3', 'button', 'B', undefined, 102),
    ]
    const formatted = formatAccessibilityTree(nodes)
    const lineCount = formatted.text.split('\n').length
    expect(countAccessibilityNodes(nodes).count).toBe(lineCount)
  })

  it('count matches line count from formatter (with filter)', () => {
    const nodes = [
      node('1', 'group', undefined, ['2', '3']),
      node('2', 'button', 'Submit', undefined, 10),
      node('3', 'button', 'Cancel', undefined, 11),
    ]
    const formatted = formatAccessibilityTree(nodes, { filter: 'submit' })
    const lineCount = formatted.text === '(no matching elements)' ? 0 : formatted.text.split('\n').length
    expect(countAccessibilityNodes(nodes, { filter: 'submit' }).count).toBe(lineCount)
  })
})
