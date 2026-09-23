import { describe, expect, it } from 'vitest'
import type { AXNode, LayoutNode, LayoutSnapshot } from '../../cdp/types.js'
import { extractControls, formatControlTable, resolveRow, type Control } from './index.js'

const ATTRS = ['data-testid']
const onScreen = { x: 10, y: 10, width: 100, height: 20 }

const ax = (id: number, role: string, name: string, value?: string): AXNode => ({
  nodeId: `ax${id}`, role: { value: role }, name: { value: name }, backendDOMNodeId: id,
  ...(value !== undefined ? { value: { value } } : {}),
})

const layout = (entries: Array<[number, Partial<LayoutNode>]>): LayoutSnapshot => ({
  viewport: { width: 800, height: 600 },
  nodes: new Map(entries.map(([id, n]) => [id, { rect: onScreen, tag: 'div', attributes: {}, cursor: 'auto', ...n }])),
})

describe('extractControls + formatControlTable', () => {
  it('masks a password field value and prints the table', () => {
    const nodes = [ax(1, 'textbox', 'Логин', 'admin'), ax(2, 'textbox', 'Пароль', 'hunter2'), ax(3, 'button', 'Войти')]
    const snap = layout([
      [1, { tag: 'input', attributes: { 'data-testid': 'login-input' } }],
      [2, { tag: 'input', attributes: { type: 'password', 'data-testid': 'password' } }],
      [3, { tag: 'button', attributes: { 'data-testid': 'login-btn' } }],
    ])
    const table = formatControlTable(extractControls(nodes, snap, ATTRS), { step: 0, maxSteps: 30, untilLabel: 'testid "workspace-root"' })
    expect(table).not.toContain('hunter2')
    expect(table).toContain('[2] textbox "Пароль" testid=password · ••••')
  })

  it('excludes zero-box and offscreen nodes', () => {
    const nodes = [ax(1, 'button', 'Zero'), ax(2, 'button', 'Below'), ax(3, 'button', 'Seen')]
    const snap = layout([
      [1, { rect: { x: 10, y: 10, width: 0, height: 0 } }],
      [2, { rect: { x: 10, y: 900, width: 100, height: 20 } }],
      [3, {}],
    ])
    expect(extractControls(nodes, snap, ATTRS).map(c => c.name)).toEqual(['Seen'])
  })

  it('folds a field wrapper into its input but keeps a parent treeitem', () => {
    const big = { x: 0, y: 0, width: 300, height: 100 }
    const nodes = [ax(1, 'combobox', 'Камера'), ax(2, 'combobox', ''), ax(3, 'treeitem', 'Группа'), ax(4, 'treeitem', 'Камера 1')]
    const snap = layout([[1, { rect: big }], [2, {}], [3, { rect: { ...big, y: 200 } }], [4, { rect: { ...onScreen, y: 210 } }]])
    expect(extractControls(nodes, snap, ATTRS).map(c => c.backendDOMNodeId)).toEqual([2, 3, 4])
  })

  it('lists a tagged pointer div as an item, but not a tagged span inside a button', () => {
    const nodes = [ax(1, 'button', 'Сохранить')]
    const snap = layout([
      [1, { rect: { x: 0, y: 0, width: 200, height: 40 }, cursor: 'pointer' }],
      [2, { rect: { x: 10, y: 10, width: 50, height: 20 }, cursor: 'pointer', attributes: { 'data-testid': 'save-label' } }],
      [3, { rect: { x: 0, y: 100, width: 60, height: 60 }, cursor: 'pointer', attributes: { 'data-testid': 'widget-gis', title: 'ГИС' } }],
    ])
    expect(extractControls(nodes, snap, ATTRS).map(c => `${c.role} ${c.name}`)).toEqual(['button Сохранить', 'item ГИС'])
  })
})

describe('resolveRow', () => {
  const control = (id: number, name: string): Control => ({ backendDOMNodeId: id, role: 'button', name, states: [], isPassword: false })

  it('reuses the same node when it is still a control', () => {
    expect(resolveRow(control(1, 'Save'), [control(1, 'Save (1)')])).toEqual({ control: control(1, 'Save (1)') })
  })

  it('remaps a re-rendered node by unique fingerprint', () => {
    expect(resolveRow(control(1, 'Save'), [control(7, 'Save'), control(8, 'Cancel')])).toEqual({ control: control(7, 'Save') })
  })

  it('blocks when the fingerprint is ambiguous or absent', () => {
    expect(resolveRow(control(1, 'Save'), [control(7, 'Save'), control(8, 'Save')])).toHaveProperty('gone')
    expect(resolveRow(control(1, 'Save'), [control(8, 'Cancel')])).toHaveProperty('gone')
  })
})
