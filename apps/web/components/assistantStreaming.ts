type Node = {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: Node[]
}

/** Stable word spans let CSS animate newly inserted words without a React animation loop. */
export function rehypeStreamingWords({ enabled }: { enabled: boolean }) {
  return (tree: Node) => {
    if (!enabled) return
    function visit(node: Node) {
      if (!node.children || node.tagName === 'pre' || node.tagName === 'code') return
      node.children = node.children.flatMap((child): Node[] => {
        if (child.type !== 'text' || !child.value) {
          visit(child)
          return [child]
        }
        return (child.value.match(/\S+\s*|\s+/gu) ?? []).map((value) => ({
          type: 'element',
          tagName: 'span',
          properties: { className: ['assistant-stream-word'] },
          children: [{ type: 'text', value }],
        }))
      })
    }
    visit(tree)
  }
}
