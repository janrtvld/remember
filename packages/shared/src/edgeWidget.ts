import type { DictationState } from './dictation'
import type { AssistantAttention } from './index'

export const EDGE_WIDGET_EDGES = ['left', 'right', 'bottom'] as const
export type EdgeWidgetEdge = (typeof EDGE_WIDGET_EDGES)[number]
export function isEdgeWidgetEdge(value: unknown): value is EdgeWidgetEdge {
  return EDGE_WIDGET_EDGES.some((edge) => edge === value)
}

export function edgeWidgetBounds(area: { x: number; y: number; width: number; height: number }, edge: EdgeWidgetEdge) {
  return {
    x:
      edge === 'left'
        ? area.x
        : edge === 'right'
          ? area.x + area.width - 360
          : area.x + Math.round((area.width - 360) / 2),
    y: edge === 'bottom' ? area.y + area.height - 240 : area.y + Math.round((area.height - 240) / 2),
    width: 360,
    height: 240,
  }
}

export function edgeWidgetDropTarget(
  point: { x: number; y: number },
  area: { width: number; height: number }
): EdgeWidgetEdge | null {
  const distance = { left: point.x, right: area.width - point.x, bottom: area.height - point.y }
  const edge = EDGE_WIDGET_EDGES.reduce((nearest, candidate) =>
    distance[candidate] < distance[nearest] ? candidate : nearest
  )
  return distance[edge] >= 0 && distance[edge] <= Math.min(160, area.width / 4, area.height / 4) ? edge : null
}

export type EdgeWidgetState = {
  edge: EdgeWidgetEdge
  docking: { cursor: { x: number; y: number }; target: EdgeWidgetEdge | null } | null
  locale: 'en' | 'nl'
  alwaysOn: boolean
  recording: boolean
  agentAttention?: AssistantAttention
  dictation: Pick<DictationState, 'status' | 'startedAt' | 'level' | 'result' | 'error' | 'canRetry'> | null
}

export type EdgeWidgetAction =
  | 'assistant'
  | 'privacy'
  | 'conversation'
  | 'dictation'
  | 'dictation-cancel'
  | 'dictation-retry'
  | 'dictation-copy'
  | 'dictation-settings'

export type EdgeWidgetBridge = {
  getState: () => Promise<EdgeWidgetState>
  onState: (listener: (state: EdgeWidgetState) => void) => () => void
  setInteractive: (interactive: boolean) => void
  showContextMenu: (point: { x: number; y: number }) => void
  open: (action: EdgeWidgetAction) => Promise<void>
  beginDrag: () => Promise<void>
  finishDrag: (edge?: EdgeWidgetEdge | null) => Promise<void>
}

export const EDGE_WIDGET_CHANNELS = {
  getState: 'remember:edge-widget:state',
  stateChanged: 'remember:edge-widget:changed',
  setInteractive: 'remember:edge-widget:interactive',
  showContextMenu: 'remember:edge-widget:context-menu',
  open: 'remember:edge-widget:open',
  beginDrag: 'remember:edge-widget:begin-drag',
  finishDrag: 'remember:edge-widget:finish-drag',
} as const
