import { describe, it, expect } from 'vitest'
import type { AXNode } from '../../cdp/types.js'
import { formatAccessibilityTree, countAccessibilityNodes, diffDomText } from './index.js'

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

  describe('maxLines truncation', () => {
    function threeNodeTree() {
      return [
        node('1', 'group', 'Root', ['2', '3'], 100),
        node('2', 'button', 'A', undefined, 101),
        node('3', 'button', 'B', undefined, 102),
      ]
    }

    it('no truncation when lines <= maxLines', () => {
      // 3 lines total, maxLines=3 → no tail
      const result = formatAccessibilityTree(threeNodeTree(), { maxLines: 3 })
      const lines = result.text.split('\n')
      expect(lines).toHaveLength(3)
      expect(result.text).not.toContain('more nodes')
    })

    it('no truncation when lines === maxLines (edge case)', () => {
      const result = formatAccessibilityTree(threeNodeTree(), { maxLines: 3 })
      expect(result.text).not.toContain('more nodes')
    })

    it('truncates when lines > maxLines and appends tail', () => {
      // 3 lines total, maxLines=2 → keep 1 line + tail
      const result = formatAccessibilityTree(threeNodeTree(), { maxLines: 2 })
      const lines = result.text.split('\n')
      expect(lines).toHaveLength(2)
      expect(lines[0]).toContain('Root')
      expect(lines[1]).toBe('… 2 more nodes')
    })

    it('tail count is correct: N lines visible + "… M more nodes" = total lines', () => {
      // 3 lines total, maxLines=3 triggers no tail; maxLines=2 → 1 kept + 2 skipped
      const result = formatAccessibilityTree(threeNodeTree(), { maxLines: 2 })
      const lines = result.text.split('\n')
      // We showed maxLines-1=1 lines before tail, skipped 3-(2-1)=2 nodes
      expect(lines[1]).toBe('… 2 more nodes')
    })

    it('refs for ALL nodes are stored even when output is truncated', () => {
      // All 3 nodes have backendDOMNodeIds
      const result = formatAccessibilityTree(threeNodeTree(), { maxLines: 2 })
      // Truncated output shows only 2 lines but refs for all 3 nodes are preserved
      expect(result.refs).toHaveLength(3)
      expect(result.refs.map(r => r.backendDOMNodeId)).toEqual([100, 101, 102])
    })

    it('nextRef continues past all nodes, not just visible ones', () => {
      const result = formatAccessibilityTree(threeNodeTree(), { maxLines: 2 })
      expect(result.nextRef).toBe(4) // same as without truncation
    })

    it('no truncation when maxLines is undefined', () => {
      const result = formatAccessibilityTree(threeNodeTree())
      expect(result.text.split('\n')).toHaveLength(3)
      expect(result.text).not.toContain('more nodes')
    })

    it('maxLines=1: only tail line shown', () => {
      const result = formatAccessibilityTree(threeNodeTree(), { maxLines: 1 })
      const lines = result.text.split('\n')
      expect(lines).toHaveLength(1)
      expect(lines[0]).toBe('… 3 more nodes')
    })
  })
})

describe('formatAccessibilityTree --compact', () => {
  it('empty tree returns (empty) regardless of compact', () => {
    const result = formatAccessibilityTree([], { compact: true })
    expect(result.text).toBe('(empty)')
  })

  it('single-child chain is merged onto one line', () => {
    // group(no name) → section(no name) → button "Save"
    const nodes = [
      node('1', 'group', undefined, ['2']),
      node('2', 'section', undefined, ['3']),
      node('3', 'button', 'Save', undefined, 30),
    ]
    const result = formatAccessibilityTree(nodes, { compact: true })
    expect(result.text).toBe('group > section > button "Save" [ref=3]')
  })

  it('intermediate refs are stored even though they are not printed', () => {
    const nodes = [
      node('1', 'group', undefined, ['2'], 10),
      node('2', 'section', undefined, ['3'], 20),
      node('3', 'button', 'Save', undefined, 30),
    ]
    const result = formatAccessibilityTree(nodes, { compact: true })
    // All three refs must be present in refs array
    expect(result.refs).toContainEqual({ ref: 1, backendDOMNodeId: 10 })
    expect(result.refs).toContainEqual({ ref: 2, backendDOMNodeId: 20 })
    expect(result.refs).toContainEqual({ ref: 3, backendDOMNodeId: 30 })
    expect(result.nextRef).toBe(4)
  })

  it('multi-child nodes render normally, not merged', () => {
    const nodes = [
      node('1', 'group', undefined, ['2', '3']),
      node('2', 'button', 'A', undefined, 10),
      node('3', 'button', 'B', undefined, 20),
    ]
    const result = formatAccessibilityTree(nodes, { compact: true })
    const lines = result.text.split('\n')
    // group has two children → emits on its own line (may have fallback name)
    expect(lines[0]).toMatch(/^group/)
    expect(lines[1]).toMatch(/^\s+button "A" \[ref=\d+\]$/)
    expect(lines[2]).toMatch(/^\s+button "B" \[ref=\d+\]$/)
    // Crucially, group must NOT be merged with its children
    expect(lines).toHaveLength(3)
  })

  it('named intermediate node breaks the chain', () => {
    // group "Nav"(has name) → button "Save" — chain should NOT merge
    const nodes = [
      node('1', 'group', 'Nav', ['2']),
      node('2', 'button', 'Save'),
    ]
    const result = formatAccessibilityTree(nodes, { compact: true })
    const lines = result.text.split('\n')
    // group "Nav" has a name, so it emits on its own line
    expect(lines[0]).toContain('group "Nav"')
    expect(lines[1]).toContain('button "Save"')
    expect(lines).toHaveLength(2)
  })

  it('chain resets at multi-child node, children are indented from there', () => {
    // wrapper(no name) → container(no name) → [buttonA, buttonB]
    // Use nodes without names so fallback resolution doesn't add a name to container
    const nodes = [
      node('1', 'wrapper', undefined, ['2']),
      node('2', 'container', undefined, ['3', '4']),
      node('3', 'button', undefined, undefined, 10),
      node('4', 'button', undefined, undefined, 20),
    ]
    const result = formatAccessibilityTree(nodes, { compact: true })
    const lines = result.text.split('\n')
    // wrapper → container is a single-child chain; emits merged at indent 0
    expect(lines[0]).toBe('wrapper > container [ref=2]')
    // container has two children → they appear at chainIndent+1 = 1 → 2 spaces
    expect(lines[1]).toBe('  button [ref=3]')
    expect(lines[2]).toBe('  button [ref=4]')
  })

  it('filter + compact combined: only matching nodes appear, chain still merges', () => {
    const nodes = [
      node('1', 'group', undefined, ['2']),
      node('2', 'section', undefined, ['3', '4']),
      node('3', 'button', 'Submit', undefined, 10),
      node('4', 'button', 'Cancel', undefined, 20),
    ]
    const result = formatAccessibilityTree(nodes, { compact: true, filter: 'Submit' })
    expect(result.text).toContain('Submit')
    expect(result.text).not.toContain('Cancel')
  })

  it('compact without options: no effect when single root with no children', () => {
    const nodes = [node('1', 'button', 'OK', undefined, 5)]
    const result = formatAccessibilityTree(nodes, { compact: true })
    expect(result.text).toBe('button "OK" [ref=1]')
    expect(result.refs).toEqual([{ ref: 1, backendDOMNodeId: 5 }])
  })

  it('effectively-single-child node (InlineTextBox sibling skipped) still chains', () => {
    // section has two raw children, but one is InlineTextBox (always skipped)
    // → effectively single child → should chain
    const nodes = [
      node('1', 'group', undefined, ['2']),
      node('2', 'section', undefined, ['3', '4']),
      node('3', 'InlineTextBox', 'ignored'),
      node('4', 'button', 'Go', undefined, 40),
    ]
    const result = formatAccessibilityTree(nodes, { compact: true })
    // group → section → button "Go" should merge onto one line
    expect(result.text).toBe('group > section > button "Go" [ref=3]')
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
    expect(countAccessibilityNodes(nodes).count).toBe(3)
  })

  it('count with filter — only matching branch counted', () => {
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

describe('diffDomText', () => {
  it('identical text returns No changes', () => {
    const text = 'button "Submit" [ref=1]\n  link "Home" [ref=2]'
    expect(diffDomText(text, text)).toBe('No changes')
  })

  it('added line is prefixed with +', () => {
    const prev = 'button "Submit" [ref=1]'
    const curr = 'button "Submit" [ref=1]\nbutton "Cancel" [ref=2]'
    const result = diffDomText(prev, curr)
    expect(result).toContain('+ button "Cancel" [ref=2]')
    expect(result).not.toContain('-')
  })

  it('removed line is prefixed with -', () => {
    const prev = 'button "Submit" [ref=1]\nbutton "Cancel" [ref=2]'
    const curr = 'button "Submit" [ref=1]'
    const result = diffDomText(prev, curr)
    expect(result).toContain('- button "Cancel" [ref=2]')
    expect(result).not.toContain('+')
  })

  it('changed line appears as removal + addition', () => {
    const prev = 'button "Submit" [ref=1]'
    const curr = 'button "Save" [ref=1]'
    const result = diffDomText(prev, curr)
    expect(result).toContain('+ button "Save" [ref=1]')
    expect(result).toContain('- button "Submit" [ref=1]')
  })

  it('duplicate lines counted correctly — one removed, one kept', () => {
    const prev = 'button [ref=1]\nbutton [ref=2]'
    const curr = 'button [ref=1]'
    const result = diffDomText(prev, curr)
    // one "button [ref=2]" removed
    expect(result).toContain('- button [ref=2]')
    // the shared "button [ref=1]" should NOT appear
    expect(result).not.toContain('button [ref=1]')
  })

  it('empty prev vs non-empty curr: all lines added', () => {
    const result = diffDomText('', 'button "OK" [ref=1]')
    expect(result).toContain('+ button "OK" [ref=1]')
    // The empty string '' itself is an empty line — it won't show as removed if curr also has no empty lines
  })

  it('refs differ but content same → No changes (refs normalised)', () => {
    const prev = 'button "Submit" [ref=1]\n  link "Home" [ref=2]'
    const curr = 'button "Submit" [ref=99]\n  link "Home" [ref=100]'
    expect(diffDomText(prev, curr)).toBe('No changes')
  })

  it('real change with shifted refs reports only the actual delta', () => {
    const prev = 'button "Submit" [ref=1]\nbutton "Cancel" [ref=2]'
    const curr = 'button "Submit" [ref=10]\nbutton "Confirm" [ref=11]'
    const result = diffDomText(prev, curr)
    expect(result).toContain('+ button "Confirm" [ref=11]')
    expect(result).toContain('- button "Cancel" [ref=2]')
    // Submit line stayed (only ref changed), should NOT appear
    expect(result).not.toContain('Submit')
  })
})
