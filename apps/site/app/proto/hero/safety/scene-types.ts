import type * as THREE from 'three'

export type CatchImpact = { x: number; z: number; age: number; strength: number }

export type SculptureFrame = {
  dt: number
  time: number
  pointer: THREE.Vector2
  dragging: boolean
  drag: number
  impacts: CatchImpact[]
  reducedMotion: boolean
}

export type Landing = {
  position: THREE.Vector3
  rotation: THREE.Euler
}

export type SafetySculpture = {
  group: THREE.Group
  /** Floor contact for each of the eight work fragments; y is the top surface. */
  landing: (index: number) => Landing
  update: (frame: SculptureFrame) => void
  /** Optional parameter used by both pointer dragging and the keyboard control. */
  setOpen?: (open: boolean) => void
  isOpen?: () => boolean
  dispose: () => void
}

export type SceneVariant = 'net' | 'ribbon' | 'drawer'
