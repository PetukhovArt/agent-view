import type { AXNode, Point } from './types.js'

type FrameTreeNode = { frame: { id: string; url: string }; childFrames?: FrameTreeNode[] }

export type FramesDomains = {
  Page: { getFrameTree: () => Promise<{ frameTree: FrameTreeNode }> }
  DOM: {
    getFrameOwner: (p: { frameId: string }) => Promise<{ backendNodeId: number }>
    describeNode: (p: Record<string, unknown>) => Promise<{ node: { backendNodeId: number; contentDocument?: { backendNodeId: number } } }>
    getBoxModel: (p: Record<string, unknown>) => Promise<{ model: { content: number[] } }>
  }
  Accessibility: { getFullAXTree: (p?: { frameId?: string }) => Promise<{ nodes: AXNode[] }> }
  Target: { getTargets: () => Promise<{ targetInfos: Array<{ targetId: string; type: string; url: string }> }> }
}

export type FrameDocument = {
  frameId: string
  documentBackendNodeId: number
  ownerBackendNodeId?: number
}

export type Frames = {
  sameProcessDocuments: () => Promise<FrameDocument[]>
  mergedAXTree: () => Promise<AXNode[]>
  childFrameOrigins: (frameIds: readonly string[]) => Promise<Map<string, Point>>
  outOfProcessFrameUrls: () => Promise<string[]>
}

const depthFirst = (node: FrameTreeNode): FrameTreeNode[] => [node, ...(node.childFrames ?? []).flatMap(depthFirst)]

export function attachFrames({ Page, DOM, Accessibility, Target }: FramesDomains, mainDocument: () => number): Frames {
  async function childDocument(frameId: string): Promise<FrameDocument | undefined> {
    const owner = await DOM.getFrameOwner({ frameId }).catch(() => undefined)
    if (!owner) return undefined
    const described = await DOM.describeNode({ backendNodeId: owner.backendNodeId, depth: 0, pierce: true }).catch(() => undefined)
    const content = described?.node.contentDocument
    return content && { frameId, documentBackendNodeId: content.backendNodeId, ownerBackendNodeId: owner.backendNodeId }
  }

  async function sameProcessDocuments(): Promise<FrameDocument[]> {
    const { frameTree } = await Page.getFrameTree()
    const [main, ...children] = depthFirst(frameTree)
    const found = await Promise.all(children.map(child => childDocument(child.frame.id)))
    return [{ frameId: main.frame.id, documentBackendNodeId: mainDocument() }, ...found.filter(doc => doc !== undefined)]
  }

  async function mergedAXTree(): Promise<AXNode[]> {
    const [, ...children] = await sameProcessDocuments()
    const { nodes } = await Accessibility.getFullAXTree()
    if (children.length === 0) return nodes
    const trees = await Promise.all(children.map(doc =>
      Accessibility.getFullAXTree({ frameId: doc.frameId }).then(tree => ({ doc, nodes: tree.nodes }), () => undefined)))
    const all = [...nodes, ...trees.flatMap(tree => tree?.nodes ?? [])]
    const byBackendId = new Map(all.filter(n => n.backendDOMNodeId !== undefined).map(n => [n.backendDOMNodeId, n]))
    for (const tree of trees) {
      const owner = tree && byBackendId.get(tree.doc.ownerBackendNodeId)
      const root = tree?.nodes[0]
      if (owner && root) owner.childIds = [...(owner.childIds ?? []), root.nodeId]
    }
    return all
  }

  async function childFrameOrigins(frameIds: readonly string[]): Promise<Map<string, Point>> {
    const found = await Promise.all(frameIds.map(async frameId => {
      const owner = await DOM.getFrameOwner({ frameId }).catch(() => undefined)
      const box = owner && await DOM.getBoxModel({ backendNodeId: owner.backendNodeId }).catch(() => undefined)
      return box ? [[frameId, { x: box.model.content[0], y: box.model.content[1] }] as const] : []
    }))
    return new Map(found.flat())
  }

  async function outOfProcessFrameUrls(): Promise<string[]> {
    const { targetInfos } = await Target.getTargets().catch(() => ({ targetInfos: [] }))
    const frames = targetInfos.filter(t => t.type === 'iframe')
    const isOwnedHere = await Promise.all(frames.map(t => DOM.getFrameOwner({ frameId: t.targetId }).then(() => true, () => false)))
    return frames.filter((_, i) => isOwnedHere[i]).map(t => t.url)
  }

  return { sameProcessDocuments, mergedAXTree, childFrameOrigins, outOfProcessFrameUrls }
}
