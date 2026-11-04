import * as THREE from 'three'
import type { Landing, SafetySculpture, SculptureFrame } from './scene-types'

const HALF_WIDTH = 4
const HALF_DEPTH = 1.8
const WARP_INTERVALS = 72
const WEFT_INTERVALS = 32
const SIDES = 5
const TAU = Math.PI * 2

// A small number of merged meshes preserves the fine weave without one draw per thread.
type Strand = {
  axis: 'x' | 'z'
  fixed: number
  segments: number
  radius: number
  phase: number
  weave: boolean
  lift: number
}

type ThreadGeometry = {
  geometry: THREE.BufferGeometry
  update: () => void
}

const landingPoints = [
  [-2.45, 0.58, -0.045],
  [-0.82, -0.58, 0.055],
  [0.82, 0.58, -0.035],
  [2.45, -0.58, 0.045],
  [-2.45, -0.58, 0.035],
  [-0.82, 0.58, -0.045],
  [0.82, -0.58, 0.035],
  [2.45, 0.58, -0.055],
] as const

export function createNetSculpture(): SafetySculpture {
  const group = new THREE.Group()
  group.name = 'Remember woven safety net'

  let impacts: SculptureFrame['impacts'] = []
  let reducedMotion = false
  let pull = 0
  let pullVelocity = 0
  let pullX = 0
  let pullZ = 0
  let wasMoving = false

  const heightAt = (x: number, z: number) => {
    const u = x / HALF_WIDTH
    const v = z / (HALF_DEPTH * (0.88 + 0.12 * u * u))
    const along = (Math.cosh(u * 1.75) - 1) / (Math.cosh(1.75) - 1)
    const across = (Math.cosh(v * 1.35) - 1) / (Math.cosh(1.35) - 1)
    let y = 0.38 + 0.62 * along + 0.4 * across
    y += 0.04 * Math.sin(u * Math.PI) * (1 - v * v) + 0.025 * u * v

    // The corners remain anchored; the free, curved edges can transmit a small wave.
    const freedom = Math.max(0, 1 - u ** 6 * v ** 6)
    const dx = x - pullX
    const dz = z - pullZ
    y += pull * Math.exp(-(dx * dx) / 1.55 - (dz * dz) / 0.7) * freedom

    if (!reducedMotion) {
      for (const impact of impacts) {
        if (impact.age < 0 || impact.age > 2.4) continue
        const distance = Math.hypot(x - impact.x, (z - impact.z) * 1.08)
        const strength = Math.min(1.8, Math.max(0, impact.strength))
        const age = impact.age
        const dip = -0.2 * Math.sin(age * 11) * Math.exp(-age * 3.7 - distance * distance * 1.45)
        const wavefront = distance - age * 2.2
        const ripple = 0.028 * Math.sin(distance * 8 - age * 10) * Math.exp(-wavefront * wavefront * 5 - age * 2.7)
        y += (dip + ripple) * strength * freedom
      }
    }

    return y
  }

  const pointAt = (strand: Strand, t: number, target: Float32Array, offset: number) => {
    const moving = t * 2 - 1
    const u = strand.axis === 'x' ? moving : strand.fixed
    const v = strand.axis === 'z' ? moving : strand.fixed
    const x = HALF_WIDTH * u
    const z = HALF_DEPTH * v * (0.88 + 0.12 * u * u)
    const intervals = strand.axis === 'x' ? WARP_INTERVALS : WEFT_INTERVALS
    const overUnder = strand.axis === 'x' ? 1 : -1
    const weave = strand.weave ? Math.cos(t * intervals * Math.PI + strand.phase) * 0.0085 * overUnder : 0

    target[offset] = x
    target[offset + 1] = heightAt(x, z) + weave + strand.lift
    target[offset + 2] = z
  }

  const makeThreads = (strands: Strand[]): ThreadGeometry => {
    const vertexCount = strands.reduce((count, strand) => count + (strand.segments + 1) * SIDES, 0)
    const indexCount = strands.reduce((count, strand) => count + strand.segments * SIDES * 6, 0)
    const positions = new Float32Array(vertexCount * 3)
    const normals = new Float32Array(vertexCount * 3)
    const indices = new Uint32Array(indexCount)
    const centers = strands.map((strand) => new Float32Array((strand.segments + 1) * 3))
    const geometry = new THREE.BufferGeometry()
    const positionAttribute = new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage)
    const normalAttribute = new THREE.BufferAttribute(normals, 3).setUsage(THREE.DynamicDrawUsage)
    geometry.setAttribute('position', positionAttribute)
    geometry.setAttribute('normal', normalAttribute)
    geometry.setIndex(new THREE.BufferAttribute(indices, 1))
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1, 0), 5.1)

    let firstVertex = 0
    let indexOffset = 0
    for (const strand of strands) {
      for (let segment = 0; segment < strand.segments; segment++) {
        for (let side = 0; side < SIDES; side++) {
          const a = firstVertex + segment * SIDES + side
          const b = firstVertex + segment * SIDES + ((side + 1) % SIDES)
          const c = a + SIDES
          const d = b + SIDES
          indices.set([a, c, b, b, c, d], indexOffset)
          indexOffset += 6
        }
      }
      firstVertex += (strand.segments + 1) * SIDES
    }

    const update = () => {
      let vertexOffset = 0
      for (const [strandIndex, strand] of strands.entries()) {
        const center = centers[strandIndex]
        for (let segment = 0; segment <= strand.segments; segment++) {
          pointAt(strand, segment / strand.segments, center, segment * 3)
        }

        for (let segment = 0; segment <= strand.segments; segment++) {
          const current = segment * 3
          const before = Math.max(0, segment - 1) * 3
          const after = Math.min(strand.segments, segment + 1) * 3
          let tx = center[after] - center[before]
          let ty = center[after + 1] - center[before + 1]
          let tz = center[after + 2] - center[before + 2]
          const length = Math.hypot(tx, ty, tz)
          tx /= length
          ty /= length
          tz /= length
          const horizontal = Math.hypot(tx, tz)
          const sx = -tz / horizontal
          const sz = tx / horizontal
          const nx = -sz * ty
          const ny = sz * tx - sx * tz
          const nz = sx * ty

          for (let side = 0; side < SIDES; side++) {
            const theta = (side / SIDES) * TAU
            const c = Math.cos(theta)
            const s = Math.sin(theta)
            const normalX = sx * c + nx * s
            const normalY = ny * s
            const normalZ = sz * c + nz * s
            positions[vertexOffset] = center[current] + normalX * strand.radius
            positions[vertexOffset + 1] = center[current + 1] + normalY * strand.radius
            positions[vertexOffset + 2] = center[current + 2] + normalZ * strand.radius
            normals[vertexOffset] = normalX
            normals[vertexOffset + 1] = normalY
            normals[vertexOffset + 2] = normalZ
            vertexOffset += 3
          }
        }
      }
      positionAttribute.needsUpdate = true
      normalAttribute.needsUpdate = true
    }

    update()
    return { geometry, update }
  }

  const warp = makeThreads(
    Array.from({ length: WEFT_INTERVALS + 1 }, (_, index) => ({
      axis: 'x' as const,
      fixed: (index / WEFT_INTERVALS) * 2 - 1,
      segments: WARP_INTERVALS * 2,
      radius: 0.0075,
      phase: index * Math.PI,
      weave: true,
      lift: 0,
    }))
  )
  const weft = makeThreads(
    Array.from({ length: WARP_INTERVALS + 1 }, (_, index) => ({
      axis: 'z' as const,
      fixed: (index / WARP_INTERVALS) * 2 - 1,
      segments: WEFT_INTERVALS * 2,
      radius: 0.008,
      phase: index * Math.PI,
      weave: true,
      lift: 0,
    }))
  )

  const rimStrands: Strand[] = [
    { axis: 'x', fixed: -1, segments: 144, radius: 0.022, phase: 0, weave: false, lift: 0.002 },
    { axis: 'x', fixed: 1, segments: 144, radius: 0.022, phase: 0, weave: false, lift: 0.002 },
    { axis: 'z', fixed: -1, segments: 64, radius: 0.022, phase: 0, weave: false, lift: 0.002 },
    { axis: 'z', fixed: 1, segments: 64, radius: 0.022, phase: 0, weave: false, lift: 0.002 },
  ]
  const rim = makeThreads(rimStrands)
  const blue = makeThreads(rimStrands.map((strand) => ({ ...strand, radius: 0.0125, lift: 0.02 })))

  const silver = new THREE.MeshPhysicalMaterial({
    color: '#bdcada',
    metalness: 0.58,
    roughness: 0.3,
    clearcoat: 0.2,
    clearcoatRoughness: 0.28,
    envMapIntensity: 0.85,
  })
  const white = new THREE.MeshPhysicalMaterial({
    color: '#f3f6fa',
    metalness: 0.36,
    roughness: 0.34,
    envMapIntensity: 0.85,
  })
  const cobalt = new THREE.MeshPhysicalMaterial({
    color: '#0748d8',
    metalness: 0.32,
    roughness: 0.26,
    clearcoat: 0.3,
    clearcoatRoughness: 0.2,
    envMapIntensity: 0.8,
  })

  for (const [threads, material, name] of [
    [warp, silver, 'Silver warp threads'],
    [weft, white, 'White weft threads'],
    [rim, white, 'Bound selvedge'],
    [blue, cobalt, 'Cobalt tension edge'],
  ] as const) {
    const mesh = new THREE.Mesh(threads.geometry, material)
    mesh.name = name
    mesh.castShadow = true
    mesh.receiveShadow = true
    group.add(mesh)
  }

  const tangent = new THREE.Vector3()
  const across = new THREE.Vector3()
  const normal = new THREE.Vector3()
  const orientation = new THREE.Matrix4()
  const quaternion = new THREE.Quaternion()
  const twist = new THREE.Quaternion()

  const landing = (index: number): Landing => {
    const [x, z, angle] = landingPoints[((index % landingPoints.length) + landingPoints.length) % landingPoints.length]
    const step = 0.015
    const slopeX = (heightAt(x + step, z) - heightAt(x - step, z)) / (step * 2)
    const slopeZ = (heightAt(x, z + step) - heightAt(x, z - step)) / (step * 2)
    normal.set(-slopeX, 1, -slopeZ).normalize()
    tangent.set(1, slopeX, 0).normalize()
    across.crossVectors(normal, tangent).normalize()
    orientation.makeBasis(tangent, across, normal)
    quaternion.setFromRotationMatrix(orientation)
    twist.setFromAxisAngle(normal, angle)
    quaternion.premultiply(twist)

    return {
      position: new THREE.Vector3(x, heightAt(x, z) + 0.04, z),
      rotation: new THREE.Euler().setFromQuaternion(quaternion),
    }
  }

  return {
    group,
    landing,
    update(frame) {
      impacts = frame.impacts
      reducedMotion = frame.reducedMotion
      const dt = Math.min(0.032, Math.max(0, frame.dt))
      const target = frame.dragging ? 0.2 + Math.min(1, Math.abs(frame.drag)) * 0.58 : 0

      if (frame.dragging) {
        pullX = THREE.MathUtils.clamp(frame.pointer.x, -1, 1) * 2.9
        pullZ = THREE.MathUtils.clamp(-frame.pointer.y, -1, 1) * 1.05
      }

      if (reducedMotion) {
        pull = target
        pullVelocity = 0
      } else {
        pullVelocity += ((target - pull) * 115 - pullVelocity * 21) * dt
        pull += pullVelocity * dt
        if (Math.abs(target - pull) < 0.0005 && Math.abs(pullVelocity) < 0.003) {
          pull = target
          pullVelocity = 0
        }
      }

      const moving =
        frame.dragging ||
        pull !== target ||
        pullVelocity !== 0 ||
        (!reducedMotion && impacts.some((impact) => impact.age < 2.4))
      if (moving || wasMoving) {
        warp.update()
        weft.update()
        rim.update()
        blue.update()
      }
      wasMoving = moving
    },
    dispose() {},
  }
}
